const { app } = require('electron')
const log = require('electron-log')
const fs = require('fs-extra')
const { is } = require('electron-util')

const { listResults } = require('./actions')
const { Runner } = require('./utils/ooni/run')
const onboard = require('./utils/ooni/onboard')
const store = require('./utils/store')
const { getConfig, setConfig } = require('./utils/config')

// BUG: The idea *was* to use these constants across main and renderer processes
// to wire up the IPC channels. But importing these directly from renderer
// scripts throws this error: https://github.com/sindresorhus/electron-util/issues/27
const inputFileRequest = 'fs.write.request'
const inputFileResponse = 'fs.write.response'
const lastResultRequest = 'results.last.request'
const lastResultResponse = 'results.last.response'

let testRunner = null
let stopRequested = false
let autorunPromptWaiting = false
let autorunTaskUpdating = false

const ipcBindingsForMain = (ipcMain) => {

  ipcMain.on(inputFileRequest, async (event, data) => {
    const tempDirectoryPath = app.getPath('temp')
    const tempFilename = `${tempDirectoryPath}/${Date.now()}`
    fs.writeFileSync(tempFilename, data.toString())

    // NOTE: We should watch out if this can cause UI/renderer process to block
    event.reply(inputFileResponse, {
      filename: tempFilename
    })
  })

  ipcMain.on(lastResultRequest, async (event, data) => {
    const { testGroupName } = data
    let lastTested = null
    try {
      const results = await listResults()
      if ('rows' in results && results.rows.length > 0) {
        const filteredRows = results.rows.filter(row =>
          testGroupName !== 'all' ? row.name === testGroupName : true
        )
        lastTested = filteredRows.length > 0
          ? filteredRows[filteredRows.length - 1].start_time
          : null
      }
    } catch (e) {
      log.error(e)
    } finally {
      log.debug(`Sending lastResultResponse: ${lastTested}`)
      event.reply(lastResultResponse, {
        lastResult: lastTested
      })
    }
  })

  ipcMain.on('ooniprobe.run', async (event, { testGroupToRun, inputFile }) => {
    const sender = event.sender
    // TODO: Should figure out a way to share this list between main and renderer
    // Cannot import `testGroups` as-is from 'renderer/components/nettests/index.js'
    const supportedTestGroups = ['websites', 'circumvention', 'im', 'middlebox', 'performance']
    // if testGroupToRun is `all` then iterate on a list of all runnable testGroups
    // instead of launching `ooniprobe all` to avoid the maxRuntimeTimer killing
    // tests other than `websites`
    const groupsToRun = testGroupToRun === 'all' ? (
      supportedTestGroups.filter(x => x !== 'default')
    ) : (
      [testGroupToRun]
    )

    // Reset any previous
    stopRequested = false
    for (const testGroup of groupsToRun) {
      if (stopRequested) {
        stopRequested = false
        break
      }
      testRunner = new Runner({
        testGroupName: testGroup,
        inputFile: inputFile
      })

      try {
        sender.send('ooniprobe.running-test', testGroup)
        await testRunner.run()
        sender.send('ooniprobe.done', testGroup)
      } catch (error) {
        sender.send('ooniprobe.error', error)
      }
    }
    sender.send('ooniprobe.completed')
    testRunner = null
  })

  ipcMain.on('ooniprobe.stop', async (event) => {
    if (!testRunner) {
      // if there is not test running, then tell renderer to move on
      stopRequested = false
      event.sender.send('ooniprobe.completed')
    } else {
      testRunner.kill()
      stopRequested = true
    }
  })

  ipcMain.handle('config.onboard', async (event, { optout = false }) => {
    await onboard({ optout })
  })

  ipcMain.handle('autorun.schedule', async () => {
    if (autorunTaskUpdating) {
      return false
    }
    autorunTaskUpdating = true
    try {
      const { scheduleAutorun } = require('./utils/autorun/schedule')
      await scheduleAutorun()
      log.debug('Autorun scheduled.')
      store.set('autorun.remind', false)
      store.set('autorun.enabled', true)
      autorunTaskUpdating = false
      return true
    } catch(e) {
      log.error(`Autorun could not be scheduled. ${e}`)
      autorunTaskUpdating = false
      return false
    }
  })

  ipcMain.handle('autorun.disable', async () => {
    if (autorunTaskUpdating) {
      return false
    }
    try {
      const { disableAutorun } = require('./utils/autorun/schedule')
      await disableAutorun()
      log.debug('Autorun disabled.')
      store.set('autorun.remind', false)
      store.set('autorun.enabled', false)
      autorunTaskUpdating = false
      return true
    } catch(e) {
      log.error(`Autorun could not be disabled. ${e}`)
      autorunTaskUpdating = false
      return false
    }
  })

  // Wait a bit since last reminder, backing off exponentially, to show the prompt with a delay from trigger (page load)
  const MAX_BACKOFF = 42
  const MIN_TIME_SINCE_LAST_REMINDER = 10 * 60 * 1000
  const SHOW_PROMPT_AFTER_DELAY = 10 * 1000

  ipcMain.on('autorun.remind-later', async () => {
    const { backoff, nextBackoff } = store.get('autorun')
    store.set('autorun.nextBackoff', Math.min(backoff + nextBackoff, MAX_BACKOFF))
    store.set('autorun.backoff', 0)
    log.debug(`Autorun reminder backed off ${nextBackoff} times.`)
  })

  ipcMain.on('autorun.cancel', async () => {
    store.set('autorun.remind', false)
    store.set('autorun.enabled', false)
    log.debug('Autorun cancelled.')
  })

  ipcMain.on('autorun.maybe-remind', async (event) => {
    // autorun is only available on mac and windows right now
    if (!(is.windows || is.macos)) {
      log.debug('Skip reminding about autorun because it is only available in MacOS and Windows.')
      return
    }
    // check if autorun is already cancelled or enabled in preferences, then skip the reminder
    const autorunPrefs = store.get('autorun')
    if (autorunPrefs.remind === false || autorunPrefs.enabled === true) {
      log.debug('Skip reminding about autorun because it is already already enabled or explicitly cancelled.')
      return
    }

    // Exponential back-off
    if(autorunPrefs.backoff < autorunPrefs.nextBackoff) {
      log.debug(`Skip autorun reminder. Backing off until ${autorunPrefs.nextBackoff - autorunPrefs.backoff} times.`)
      store.set('autorun.backoff', autorunPrefs.backoff + 1)
      return
    }

    // Don't remind too soon
    const timeSinceLastReminder = Date.now() - autorunPrefs.timestamp
    if (timeSinceLastReminder < MIN_TIME_SINCE_LAST_REMINDER) {
      log.debug(`Skip autorun reminder. Its only been ${Math.ceil(timeSinceLastReminder/60000)} minutes.`)
      return
    }

    // Ask renderer to show the prompt
    if (!autorunPromptWaiting) {
      autorunPromptWaiting = true
      setTimeout(() => {
        event.sender.send('autorun.showPrompt')
        autorunPromptWaiting = false
        store.set('autorun.timestamp', Date.now())
      }, SHOW_PROMPT_AFTER_DELAY)
    }
  })

  ipcMain.handle('list-results', async (event, resultID = null) => {
    const { listResults, listMeasurements } = require('./actions')
    if (resultID) {
      return listMeasurements(resultID)
    } else {
      return listResults()
    }
  })

  ipcMain.on('prefs.save', (event, { key, value }) => {
    try {
      store.set(key, value)
      event.returnValue = true
    } catch (e) {
      log.error(e)
      event.returnValue = e.message
    }
  })

  ipcMain.on('prefs.get', (event, key) => {
    try {
      const value = store.get(key)
      log.verbose(`prefs.get ${key}: ${value}`)
      event.returnValue = value
    } catch(e) {
      log.error(e)
      event.returnValue = undefined
    }
  })

  ipcMain.handle('config.get', async (event, key) => {
    const value = await getConfig(key)
    log.verbose(`ipcMain: config.get ${key}: ${value}`)
    return value
  })

  ipcMain.handle('config.set', async (event, {key, value}) => {
    const config = await getConfig()
    const currentValue = key.split('.').reduce((o,i) => o[i], config)
    const newConfig = await setConfig(key, currentValue, value)
    return newConfig
  })

}

module.exports = {
  inputFileRequest,
  inputFileResponse,
  lastResultRequest,
  lastResultResponse,
  ipcBindingsForMain
}