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
          "name": "trigger",
          "type": {
            "defined": {
              "name": "triggerSpec"
            }
          }
        },
        {
          "name": "action",
          "type": {
            "defined": {
              "name": "actionSpec"
            }
          }
        }
      ]
    },
    {
      "name": "createAutomationSpl",
      "discriminator": [
        63,
        96,
        147,
        48,
        149,
        70,
        190,
        239
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
          "name": "mint"
        },
        {
          "name": "ownerAta",
          "docs": [
            "Owner's ATA — must already hold `amount` tokens of `mint`."
          ],
          "writable": true
        },
        {
          "name": "automationAta",
          "docs": [
            "Automation PDA's ATA — must be pre-created and owned by `automation`."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "trigger",
          "type": {
            "defined": {
              "name": "triggerSpec"
            }
          }
        },
        {
          "name": "action",
          "type": {
            "defined": {
              "name": "actionSpec"
            }
          }
        }
      ]
    },
    {
      "name": "createAutomationStake",
      "discriminator": [
        218,
        192,
        68,
        169,
        160,
        20,
        30,
        108
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
          "name": "trigger",
          "type": {
            "defined": {
              "name": "triggerSpec"
            }
          }
        },
        {
          "name": "action",
          "type": {
            "defined": {
              "name": "actionSpec"
            }
          }
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
      "name": "executeAutomationSpl",
      "discriminator": [
        105,
        81,
        76,
        61,
        184,
        94,
        71,
        42
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
          "name": "mint"
        },
        {
          "name": "automationAta",
          "docs": [
            "Source ATA owned by the automation PDA."
          ],
          "writable": true
        },
        {
          "name": "destinationAta",
          "docs": [
            "Destination ATA — owned by the action's declared destination",
            "wallet. Must be pre-created by the keeper / caller."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "executeRestake",
      "discriminator": [
        44,
        47,
        178,
        120,
        58,
        15,
        210,
        101
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
          "name": "stakeAccount",
          "writable": true
        },
        {
          "name": "voteAccount"
        },
        {
          "name": "clockSysvar",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "stakeHistorySysvar",
          "address": "SysvarStakeHistory1111111111111111111111111"
        },
        {
          "name": "stakeConfig",
          "address": "StakeConfig11111111111111111111111111111111"
        },
        {
          "name": "stakeProgram",
          "address": "Stake11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "executeWithdrawReward",
      "discriminator": [
        177,
        123,
        100,
        94,
        160,
        211,
        109,
        7
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
          "name": "stakeAccount",
          "writable": true
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "clockSysvar",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "stakeHistorySysvar",
          "address": "SysvarStakeHistory1111111111111111111111111"
        },
        {
          "name": "stakeProgram",
          "address": "Stake11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
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
    },
    {
      "code": 6005,
      "name": "actionMismatch",
      "msg": "Action mismatch — provided accounts do not match the configured action"
    },
    {
      "code": 6006,
      "name": "wrongMint",
      "msg": "SPL mint mismatch"
    },
    {
      "code": 6007,
      "name": "wrongStakeAccount",
      "msg": "Stake account does not match automation"
    },
    {
      "code": 6008,
      "name": "wrongVoteAccount",
      "msg": "Vote account does not match automation"
    },
    {
      "code": 6009,
      "name": "badComparator",
      "msg": "Token-price comparator is not 0 (below) or 1 (above)"
    },
    {
      "code": 6010,
      "name": "badAccountKind",
      "msg": "Account-activity kind is not 0 (transfer) or 1 (swap)"
    },
    {
      "code": 6011,
      "name": "badStakingMode",
      "msg": "Staking-reward mode is not 0 (amount) or 1 (time)"
    },
    {
      "code": 6012,
      "name": "badPythExpo",
      "msg": "Pyth feed expo cannot be positive"
    },
    {
      "code": 6013,
      "name": "timeIntervalNotElapsed",
      "msg": "Time-based trigger fired before the configured interval elapsed"
    },
    {
      "code": 6014,
      "name": "badSplAccounts",
      "msg": "Account count or layout does not match for SPL transfer"
    },
    {
      "code": 6015,
      "name": "badStakeAccounts",
      "msg": "Account count or layout does not match for stake action"
    }
  ],
  "types": [
    {
      "name": "actionSpec",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "transferSol",
            "fields": [
              {
                "name": "destination",
                "type": "pubkey"
              },
              {
                "name": "amount",
                "type": "u64"
              }
            ]
          },
          {
            "name": "transferSpl",
            "fields": [
              {
                "name": "destination",
                "type": "pubkey"
              },
              {
                "name": "mint",
                "type": "pubkey"
              },
              {
                "name": "amount",
                "type": "u64"
              }
            ]
          },
          {
            "name": "stakeRestake",
            "fields": [
              {
                "name": "stakeAccount",
                "type": "pubkey"
              },
              {
                "name": "voteAccount",
                "type": "pubkey"
              }
            ]
          },
          {
            "name": "stakeWithdrawReward",
            "fields": [
              {
                "name": "stakeAccount",
                "type": "pubkey"
              },
              {
                "name": "destination",
                "type": "pubkey"
              }
            ]
          }
        ]
      }
    },
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
            "name": "trigger",
            "type": {
              "defined": {
                "name": "triggerSpec"
              }
            }
          },
          {
            "name": "action",
            "type": {
              "defined": {
                "name": "actionSpec"
              }
            }
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
            "name": "triggerKind",
            "docs": [
              "`0` = AccountActivity, `1` = TokenPrice, `2` = StakingReward — keeps",
              "the event slim while still letting indexers route to the right",
              "subscriber without re-fetching the account."
            ],
            "type": "u8"
          },
          {
            "name": "actionKind",
            "docs": [
              "`0` = TransferSol, `1` = TransferSpl, `2` = StakeRestake,",
              "`3` = StakeWithdrawReward."
            ],
            "type": "u8"
          },
          {
            "name": "triggerPubkey",
            "docs": [
              "Watched / feed / stake account, depending on trigger_kind."
            ],
            "type": "pubkey"
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
            "name": "actionKind",
            "type": "u8"
          },
          {
            "name": "amount",
            "docs": [
              "Lamports moved (or token base units for SPL). Keeper-provided when",
              "the amount is dynamic (stake reward), otherwise the static action",
              "amount."
            ],
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
    },
    {
      "name": "triggerSpec",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "accountActivity",
            "fields": [
              {
                "name": "account",
                "type": "pubkey"
              },
              {
                "name": "mint",
                "docs": [
                  "`Some(mint)` to filter to a specific SPL mint, `None` for any token."
                ],
                "type": {
                  "option": "pubkey"
                }
              },
              {
                "name": "kind",
                "docs": [
                  "`account_kind::TRANSFER` or `account_kind::SWAP`."
                ],
                "type": "u8"
              }
            ]
          },
          {
            "name": "tokenPrice",
            "fields": [
              {
                "name": "feed",
                "type": "pubkey"
              },
              {
                "name": "comparator",
                "docs": [
                  "`comparator::BELOW` or `comparator::ABOVE`."
                ],
                "type": "u8"
              },
              {
                "name": "threshold",
                "docs": [
                  "Price threshold scaled to `10^expo` (matches Pyth's wire format)."
                ],
                "type": "i64"
              },
              {
                "name": "expo",
                "docs": [
                  "Pyth feed exponent (negative for decimals). Captured at create",
                  "time so the keeper can normalize against future feed updates."
                ],
                "type": "i32"
              }
            ]
          },
          {
            "name": "stakingReward",
            "fields": [
              {
                "name": "stakeAccount",
                "type": "pubkey"
              },
              {
                "name": "mode",
                "docs": [
                  "`staking_mode::AMOUNT` or `staking_mode::TIME`."
                ],
                "type": "u8"
              },
              {
                "name": "value",
                "docs": [
                  "AMOUNT mode: lamports threshold. TIME mode: interval in seconds."
                ],
                "type": "u64"
              }
            ]
          }
        ]
      }
    }
  ]
};
