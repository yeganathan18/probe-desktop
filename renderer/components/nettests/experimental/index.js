import React from 'react'
import { theme } from 'ooni-components'
import { FormattedMessage } from 'react-intl'
import { NettestGroupExperimental } from 'ooni-components/dist/icons'
import animation from 'ooni-components/components/animations/RunningExperimental.json'

import FormattedMarkdownMessage from '../../FormattedMarkdownMessage'

const color = theme.colors.gray7
const name = <FormattedMessage id="Test.Experimental.Fullname" />
const description = <FormattedMarkdownMessage id="Dashboard.Experimental.Card.Description" />
const longDescription = <div>
  <FormattedMarkdownMessage
    id={'Dashboard.Experimental.Overview.Paragraph'}
    values={{
      experimental_test_list: '* **stun-reachability**\n* **dnscheck**\n* **torsf**\n'
    }}
  />
</div>

const icon = <NettestGroupExperimental />

export default {
  color,
  name,
  icon,
  description,
  longDescription,
  animation,
  estimatedSize: 'N/A',
  estimatedTimeInSec: () => 30
}
