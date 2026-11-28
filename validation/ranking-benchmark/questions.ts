export const scenarios = [
  ['infra', 'Where is the ledger database hosted?', 'ledger database uses the north datacenter'],
  ['infra', 'Which cache stores checkout sessions?', 'checkout sessions use the spruce cache'],
  [
    'infra',
    'Where are invoice snapshots archived?',
    'invoice snapshots are archived in the glacier bucket'
  ],
  [
    'infra',
    'What protects payment secrets?',
    'payment secrets are encrypted with the vault transit key'
  ],
  ['config', 'What is the retry limit for settlement?', 'settlement retry limit is seven attempts'],
  [
    'config',
    'What config rule controls connection pooling?',
    'connection pooling config rule caps each worker at twelve sockets'
  ],
  [
    'config',
    'When should receipt processing time out?',
    'receipt processing timeout is forty seconds'
  ],
  [
    'config',
    'How is currency rounding configured?',
    'currency rounding uses bankers rounding for all invoices'
  ],
  [
    'billing',
    'How does billing handle refunds?',
    'billing refunds require an immutable credit note'
  ],
  [
    'billing',
    'Who owns subscription proration?',
    'subscription proration is owned by the revenue team'
  ],
  ['billing', 'What happens to failed charges?', 'failed charges enter the dunning workflow'],
  [
    'billing',
    'How are billing taxes calculated?',
    'billing taxes are calculated by the regional tax adapter'
  ],
  ['role', 'What does service-a do?', 'service-a owns order intake and payment orchestration'],
  [
    'overview',
    'What does service-b do?',
    'service-b runs asynchronous fulfillment and notification workers'
  ],
  ['role', 'What does shared do?', 'shared provides transport types and common order contracts'],
  [
    'link',
    'Which repos call the fraud gateway?',
    'service-a calls the fraud gateway in service-b before authorization'
  ],
  [
    'link',
    'Who produces the fulfillment queue?',
    'service-a produces the fulfillment queue consumed by service-b'
  ],
  [
    'link',
    'Who consumes the receipt queue?',
    'service-b consumes the receipt queue published by service-a'
  ],
  [
    'link',
    'Which repos call the exchange adapter?',
    'service-b calls the exchange adapter in shared for conversion'
  ],
  [
    'link',
    'Which repos read the inventory resource?',
    'service-a reads the inventory resource maintained by shared'
  ]
] as const;
