/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sotama_automations.json`.
 */
export type SotamaAutomations = {
  "address": "2gp9bMBEVpQp6Lyyg13Bw6XF9S9saAcm9C4XQ69T8ZqQ",
  "metadata": {
    "name": "sotamaAutomations",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Sotama on-chain automation program"
  },
  "instructions": [
    {
      "name": "closeAutomation",
      "discriminator": [
        173,
        28,
        100,
        215,
        243,
        180,
        140,
        234
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "automation"
          ]
        },
        {
          "name": "automation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  111,
                  109,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "automation.nonce",
                "account": "automation"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createAutomation",
      "discriminator": [
        234,
        208,
        21,
        187,
        63,
        147,
        183,
        254
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "automation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  111,
                  109,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "config.automation_count",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "watchedAccount",
          "type": "pubkey"
        },
        {
          "name": "destination",
          "type": "pubkey"
        },
        {
          "name": "amountLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeAutomation",
      "discriminator": [
        3,
        184,
        13,
        33,
        39,
        70,
        222,
        5
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "automation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  111,
                  109,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "automation.owner",
                "account": "automation"
              },
              {
                "kind": "account",
                "path": "automation.nonce",
                "account": "automation"
              }
            ]
          }
        },
        {
          "name": "destination",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "keeper",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPaused",
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "updateKeeper",
      "discriminator": [
        36,
        13,
        12,
        225,
        221,
        94,
        23,
        151
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newKeeper",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "automation",
      "discriminator": [
        235,
        214,
        138,
        190,
        117,
        163,
        210,
        233
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    }
  ],
  "events": [
    {
      "name": "automationClosed",
      "discriminator": [
        129,
        240,
        98,
        32,
        4,
        115,
        89,
        180
      ]
    },
    {
      "name": "automationCreated",
      "discriminator": [
        93,
        27,
        226,
        106,
        218,
        246,
        239,
        115
      ]
    },
    {
      "name": "automationExecuted",
      "discriminator": [
        243,
        203,
        194,
        178,
        68,
        49,
        9,
        160
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "alreadyExecuted",
      "msg": "Automation already executed"
    },
    {
      "code": 6001,
      "name": "unauthorizedKeeper",
      "msg": "Caller is not the configured keeper"
    },
    {
      "code": 6002,
      "name": "wrongDestination",
      "msg": "Destination account does not match automation"
    },
    {
      "code": 6003,
      "name": "depositTooSmall",
      "msg": "Deposit amount is below the minimum"
    },
    {
      "code": 6004,
      "name": "paused",
      "msg": "Program is paused"
    }
  ],
  "types": [
    {
      "name": "automation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "watchedAccount",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amountLamports",
            "type": "u64"
          },
          {
            "name": "executed",
            "type": "bool"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "automationClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pubkey",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "refundLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "automationCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pubkey",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "watchedAccount",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amountLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "automationExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pubkey",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amountLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "automationCount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
