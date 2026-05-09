/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sotama_automations.json`.
 */
export type SotamaAutomations = {
  "address": "3FCzDrB9KNUe2JJQFTKjWF1LNnHdcsw3FV5kN7SmGtdw",
  "metadata": {
    "name": "sotamaAutomations",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Sotama on-chain automation program"
  },
  "instructions": [
    {
      "name": "adminCloseAutomation",
      "docs": [
        "Admin-driven kill-switch close for SOL-action automations.",
        "Requires `Config.shutdown == true`. Owner gets the SOL deposit",
        "(above-rent excess); treasury gets the rent_min."
      ],
      "discriminator": [
        189,
        234,
        222,
        52,
        33,
        76,
        156,
        254
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "owner",
          "docs": [
            "deposit portion of the PDA's lamports. No signer; admin",
            "authority alone suffices once `shutdown == true`."
          ],
          "writable": true,
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
          "name": "treasury",
          "docs": [
            "PDA's rent-exempt minimum on close (Anchor's `close = treasury`)."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "adminCloseAutomationSpl",
      "docs": [
        "Admin-driven kill-switch close for SPL-action automations.",
        "Requires `Config.shutdown == true`. Owner gets the SPL tokens",
        "(via PDA→owner ATA transfer); treasury gets all lamports",
        "(PDA rent + ATA rent)."
      ],
      "discriminator": [
        146,
        153,
        127,
        177,
        194,
        19,
        151,
        140
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "owner",
          "writable": true,
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
          "name": "treasury",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "ownerAta",
          "docs": [
            "Owner's ATA for `mint`. Must be pre-created by the caller —",
            "admin pays the rent for an idempotent ATA-create when the",
            "owner has never received this mint."
          ],
          "writable": true
        },
        {
          "name": "automationAta",
          "docs": [
            "PDA's ATA for `mint`. Drained then closed by this ix."
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
      "name": "adminCloseAutomationSwap",
      "docs": [
        "Admin-driven kill-switch close for swap-action automations.",
        "Requires `Config.shutdown == true`. Owner gets the unspent",
        "input mint (via PDA→owner ATA transfer); treasury gets all",
        "lamports (PDA rent + input-ATA rent)."
      ],
      "discriminator": [
        163,
        160,
        205,
        122,
        10,
        137,
        184,
        57
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "owner",
          "writable": true,
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
          "name": "treasury",
          "writable": true
        },
        {
          "name": "inputMint"
        },
        {
          "name": "ownerInputAta",
          "writable": true
        },
        {
          "name": "automationInputAta",
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
          "name": "treasury",
          "docs": [
            "close-fee lamports; if `config.close_fee_lamports == 0` or the",
            "PDA has no excess above rent-min, no transfer occurs and this",
            "account is read-only in effect."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "closeAutomationSpl",
      "docs": [
        "Close an SPL-action automation. Drains the PDA-owned ATA back",
        "to the owner's ATA, closes the ATA, then closes the PDA. Use",
        "this for `TransferSpl` actions; use `close_automation` for",
        "SOL actions and `close_automation_swap` for `Swap` actions."
      ],
      "discriminator": [
        222,
        158,
        94,
        76,
        125,
        129,
        159,
        145
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
          "name": "treasury",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "ownerAta",
          "docs": [
            "Owner's ATA for `mint`. Idempotent-created by the client tx",
            "before this ix runs, so we can deposit the refund into it."
          ],
          "writable": true
        },
        {
          "name": "automationAta",
          "docs": [
            "Automation PDA's ATA for `mint`. Closed by this ix after its",
            "balance is drained."
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
      "name": "closeAutomationSwap",
      "docs": [
        "Close a swap-action automation. Drains the PDA-owned input",
        "ATA back to the owner, closes the ATA, then closes the PDA."
      ],
      "discriminator": [
        236,
        180,
        11,
        100,
        111,
        50,
        165,
        96
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
          "name": "treasury",
          "writable": true
        },
        {
          "name": "inputMint"
        },
        {
          "name": "ownerInputAta",
          "writable": true
        },
        {
          "name": "automationInputAta",
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
        },
        {
          "name": "cadence",
          "type": {
            "defined": {
              "name": "cadence"
            }
          }
        },
        {
          "name": "minIntervalSecs",
          "type": "u32"
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
        },
        {
          "name": "cadence",
          "type": {
            "defined": {
              "name": "cadence"
            }
          }
        },
        {
          "name": "minIntervalSecs",
          "type": "u32"
        }
      ]
    },
    {
      "name": "createAutomationSwap",
      "discriminator": [
        194,
        175,
        106,
        22,
        29,
        218,
        54,
        250
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
          "name": "inputMint"
        },
        {
          "name": "ownerInputAta",
          "docs": [
            "Owner's ATA for `input_mint`. Source of the deposit."
          ],
          "writable": true
        },
        {
          "name": "automationInputAta",
          "docs": [
            "Automation PDA's ATA for `input_mint`. Pre-created by the client."
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
        },
        {
          "name": "cadence",
          "type": {
            "defined": {
              "name": "cadence"
            }
          }
        },
        {
          "name": "minIntervalSecs",
          "type": "u32"
        },
        {
          "name": "enableFeeTopup",
          "type": "bool"
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
      "name": "executeFeeTopup",
      "docs": [
        "Keeper-driven token-to-wSOL conversion (auto-fee-management).",
        "Swaps a slice of the PDA's holdings into wSOL on the keeper's",
        "own ATA, then the keeper unwraps off-band to refill its tx-fee",
        "budget. Same Jupiter relay shape as `execute_swap`."
      ],
      "discriminator": [
        109,
        94,
        39,
        221,
        62,
        144,
        17,
        237
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
          "name": "jupiterProgram",
          "address": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        }
      ],
      "args": [
        {
          "name": "innerIxData",
          "type": "bytes"
        },
        {
          "name": "innerIxAccountMetas",
          "type": {
            "vec": {
              "defined": {
                "name": "swapAccountMeta"
              }
            }
          }
        },
        {
          "name": "keeperWsolAtaIndex",
          "type": "u8"
        }
      ]
    },
    {
      "name": "executeLinkFeeDebit",
      "docs": [
        "Linked-rule fee debit. Bundled by the keeper before any",
        "`execute_*` ix when firing a downstream-of-link automation, so",
        "the fee debit and the action atomically succeed-or-fail. Caps",
        "`fee_lamports` at `MAX_LINK_FEE_LAMPORTS` and rejects below-rent",
        "debits."
      ],
      "discriminator": [
        215,
        166,
        203,
        162,
        222,
        248,
        138,
        151
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
          "name": "keeperRecipient",
          "docs": [
            "matches `config.keeper` below, so it's effectively the keeper.",
            "Marked CHECK because we mutate its lamports directly."
          ],
          "writable": true
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
        }
      ],
      "args": [
        {
          "name": "feeLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeSwap",
      "discriminator": [
        56,
        182,
        124,
        215,
        155,
        140,
        157,
        102
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
          "name": "jupiterProgram",
          "address": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        }
      ],
      "args": [
        {
          "name": "innerIxData",
          "type": "bytes"
        },
        {
          "name": "innerIxAccountMetas",
          "type": {
            "vec": {
              "defined": {
                "name": "swapAccountMeta"
              }
            }
          }
        },
        {
          "name": "inputAtaIndex",
          "type": "u8"
        },
        {
          "name": "outputAtaIndex",
          "type": "u8"
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
      "name": "migrateConfig",
      "docs": [
        "One-shot devnet migration: realloc the v4.0 Config PDA to the",
        "v4.1 layout and initialize the new `treasury` + `close_fee_lamports`",
        "fields. Mainnet doesn't need this — its first `initialize_config`",
        "writes the v4.1 layout directly. Admin only."
      ],
      "discriminator": [
        92,
        131,
        58,
        105,
        210,
        154,
        224,
        193
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
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
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
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
      "name": "setShutdown",
      "docs": [
        "One-way kill switch. Admin only. Sets `Config.shutdown = true`",
        "and locks `update_treasury`, `update_close_fee`, `update_admin`,",
        "`migrate_config`, all `execute_*`, and all `create_automation*`.",
        "Enables `admin_close_automation*` for the wind-down. Reverts on",
        "a second invocation (`ShutdownAlreadySet`)."
      ],
      "discriminator": [
        118,
        99,
        163,
        234,
        208,
        40,
        221,
        53
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
      "args": []
    },
    {
      "name": "updateAdmin",
      "docs": [
        "Rotate `Config.admin`. Required for handing off control to a",
        "Squads multisig (or any other admin rotation). Admin only.",
        "Rejected when `Config.shutdown == true` — the Squads transition",
        "must happen during normal operation, before the kill switch."
      ],
      "discriminator": [
        161,
        176,
        40,
        213,
        60,
        184,
        179,
        228
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
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateCloseFee",
      "docs": [
        "Rotate `Config.close_fee_lamports` (per-close protocol fee).",
        "Admin only. Capped at `MAX_CLOSE_FEE_LAMPORTS` (0.1 SOL) so a",
        "misconfig can't make rules un-closable."
      ],
      "discriminator": [
        127,
        49,
        70,
        176,
        56,
        34,
        12,
        135
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
          "name": "newFeeLamports",
          "type": "u64"
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
    },
    {
      "name": "updateTreasury",
      "docs": [
        "Rotate `Config.treasury` (where close-fee revenue lands). Admin",
        "only. Use to migrate from `admin` (default) to a dedicated",
        "fee-collection wallet or Squads multisig."
      ],
      "discriminator": [
        60,
        16,
        243,
        66,
        96,
        59,
        254,
        131
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
          "name": "newTreasury",
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
      "name": "automationFinished",
      "msg": "Automation has reached its terminal state and cannot fire again"
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
      "name": "badComparator",
      "msg": "Token-price comparator is not 0 (below) or 1 (above)"
    },
    {
      "code": 6008,
      "name": "badAccountKind",
      "msg": "Account-activity kind is not 0 (transfer) or 1 (swap)"
    },
    {
      "code": 6009,
      "name": "badPythExpo",
      "msg": "Pyth feed expo cannot be positive"
    },
    {
      "code": 6010,
      "name": "badOracleSource",
      "msg": "AssetPrice oracle source byte is not a recognized provider"
    },
    {
      "code": 6011,
      "name": "timeIntervalNotElapsed",
      "msg": "Time-based trigger fired before the configured interval elapsed"
    },
    {
      "code": 6012,
      "name": "badCadence",
      "msg": "Cadence configuration is invalid (e.g. Repeat total = 0 or Until deadline not in the future)"
    },
    {
      "code": 6013,
      "name": "minIntervalNotElapsed",
      "msg": "Minimum interval between fires has not elapsed yet"
    },
    {
      "code": 6014,
      "name": "deadlineExpired",
      "msg": "Until-cadence deadline has passed; automation is now terminal"
    },
    {
      "code": 6015,
      "name": "wrongInputMint",
      "msg": "Swap input mint does not match automation"
    },
    {
      "code": 6016,
      "name": "wrongOutputMint",
      "msg": "Swap output mint does not match automation"
    },
    {
      "code": 6017,
      "name": "badSwapAccounts",
      "msg": "Account count or layout does not match for swap action"
    },
    {
      "code": 6018,
      "name": "wrongSwapProgram",
      "msg": "Inner swap instruction must target the Jupiter v6 program"
    },
    {
      "code": 6019,
      "name": "slippageExceeded",
      "msg": "Output ATA balance did not increase by at least min_amount_out — slippage exceeded"
    },
    {
      "code": 6020,
      "name": "swapUntilNotSupported",
      "msg": "Swap actions cannot use the Until cadence — total runs must be bounded so the deposit can cover all fires"
    },
    {
      "code": 6021,
      "name": "depositOverflow",
      "msg": "Deposit amount overflowed during cadence multiplication"
    },
    {
      "code": 6022,
      "name": "badSplAccounts",
      "msg": "Account count or layout does not match for SPL transfer"
    },
    {
      "code": 6023,
      "name": "linkedFeePoolBelowRent",
      "msg": "Linked-rule fee deposit would push the PDA below rent-exempt minimum"
    },
    {
      "code": 6024,
      "name": "linkFeeCapExceeded",
      "msg": "Fee debit exceeds MAX_LINK_FEE_LAMPORTS"
    },
    {
      "code": 6025,
      "name": "missingDownstreamAccount",
      "msg": "Linked downstream automation account is missing or wrong"
    },
    {
      "code": 6026,
      "name": "downstreamMismatch",
      "msg": "Linked downstream pubkey does not match the action's linked_downstream"
    },
    {
      "code": 6027,
      "name": "badFeeTopupOutput",
      "msg": "Fee topup output mint must be wrapped SOL"
    },
    {
      "code": 6028,
      "name": "badFeeTopupOwner",
      "msg": "Fee topup output ATA must be owned by the automation PDA"
    },
    {
      "code": 6029,
      "name": "feeTopupNotEnabled",
      "msg": "Fee topup is not enabled for this automation"
    },
    {
      "code": 6030,
      "name": "feeTooLarge",
      "msg": "Close fee exceeds protocol cap (0.1 SOL)"
    },
    {
      "code": 6031,
      "name": "wrongTreasury",
      "msg": "Provided treasury account does not match Config.treasury"
    },
    {
      "code": 6032,
      "name": "shutdown",
      "msg": "Program is in terminal shutdown — operation rejected"
    },
    {
      "code": 6033,
      "name": "notShutdown",
      "msg": "Operation requires Config.shutdown = true (kill-switch only)"
    },
    {
      "code": 6034,
      "name": "shutdownAlreadySet",
      "msg": "Shutdown is one-way; cannot be cleared once set"
    },
    {
      "code": 6035,
      "name": "unauthorizedCloser",
      "msg": "Caller is neither the automation owner nor the program admin"
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
            "name": "swap",
            "fields": [
              {
                "name": "inputMint",
                "type": "pubkey"
              },
              {
                "name": "outputMint",
                "type": "pubkey"
              },
              {
                "name": "destination",
                "type": "pubkey"
              },
              {
                "name": "amountIn",
                "type": "u64"
              },
              {
                "name": "minAmountOut",
                "type": "u64"
              },
              {
                "name": "linkedDownstream",
                "docs": [
                  "Optional downstream automation PDA that receives the",
                  "auto-deposit fee after this swap fires. The downstream PDA",
                  "must be passed as the LAST remaining account at execute time."
                ],
                "type": {
                  "option": "pubkey"
                }
              },
              {
                "name": "linkFeeDeposit",
                "docs": [
                  "Lamports prepaid to the downstream rule per fire of this",
                  "rule. Capped on-chain at `MAX_LINK_FEE_LAMPORTS`."
                ],
                "type": "u64"
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
            "name": "cadence",
            "docs": [
              "Cadence/loop semantics chosen by the user (If/While/For in the UI)."
            ],
            "type": {
              "defined": {
                "name": "cadence"
              }
            }
          },
          {
            "name": "executions",
            "docs": [
              "Number of times this automation has fired. Increments on every",
              "successful execute_*. Used by the program to enforce",
              "`Cadence::Repeat { total }` and surfaced in the UI as the run count."
            ],
            "type": "u32"
          },
          {
            "name": "minIntervalSecs",
            "docs": [
              "Minimum seconds between consecutive fires. `0` means no floor.",
              "Always enforced when `executions > 0`, regardless of cadence."
            ],
            "type": "u32"
          },
          {
            "name": "finished",
            "docs": [
              "Set true when the automation reaches its terminal state — either",
              "after a `Once` fire, after `executions == total` for `Repeat`, or",
              "when the keeper attempts a fire past `unix_deadline` for `Until`.",
              "Once set, further execute_* calls return `AutomationFinished`."
            ],
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
          },
          {
            "name": "feeTopupEnabled",
            "docs": [
              "Per-automation opt-in for `execute_fee_topup`. False by default",
              "so a leaked keeper signing key cannot route arbitrary token",
              "holdings through Jupiter. Only set true at create time on Swap",
              "rules where the user explicitly enables auto-fee-management.",
              "Carved out of the original 32-byte `_reserved` budget: 1 byte",
              "here, 31 bytes still reserved below."
            ],
            "type": "bool"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved bytes for forward-compatible field additions. Lets a",
              "future v5 add small fields via `realloc` without forcing a",
              "fresh program ID (which v3→v4 already required). Was [u8; 32];",
              "shrunk to 31 to make room for `fee_topup_enabled` above."
            ],
            "type": {
              "array": [
                "u8",
                31
              ]
            }
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
          },
          {
            "name": "feeLamports",
            "docs": [
              "Lamports diverted to `Config.treasury` before the owner refund.",
              "`0` when `Config.close_fee_lamports == 0` or when the PDA had no",
              "excess lamports above rent-exempt minimum to cover the fee."
            ],
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
              "`0` = AccountActivity, `1` = AssetPrice — keeps the event slim",
              "while still letting indexers route to the right subscriber",
              "without re-fetching the account."
            ],
            "type": "u8"
          },
          {
            "name": "actionKind",
            "docs": [
              "`0` = TransferSol, `1` = TransferSpl, `4` = Swap."
            ],
            "type": "u8"
          },
          {
            "name": "triggerPubkey",
            "docs": [
              "Watched / feed account, depending on trigger_kind."
            ],
            "type": "pubkey"
          },
          {
            "name": "cadenceKind",
            "docs": [
              "`0` = Once (If), `1` = Repeat (For), `2` = Until (While). Lets the",
              "indexer render the right control-flow icon without decoding the",
              "account's full Cadence payload."
            ],
            "type": "u8"
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
              "Lamports moved (or token base units for SPL)."
            ],
            "type": "u64"
          },
          {
            "name": "executions",
            "docs": [
              "1-indexed run count after this fire (1 = first fire). Lets indexers",
              "distinguish \"fire 3 of 10\" from \"first fire\" without re-fetching the",
              "account."
            ],
            "type": "u32"
          },
          {
            "name": "finished",
            "docs": [
              "True iff this fire put the automation into its terminal state — i.e.",
              "the keeper should stop polling it."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "cadence",
      "docs": [
        "Control-flow over the action firing schedule. Maps 1:1 to the UI's",
        "If/For/While selector.",
        "",
        "* `Once`  — fire one time when the trigger is satisfied. Terminal",
        "after the first fire (matches v2's original single-shot behavior).",
        "* `Repeat { total }` — fire up to `total` times in total. The",
        "automation becomes terminal once `executions == total`.",
        "* `Until { unix_deadline }` — fire repeatedly while",
        "`now < unix_deadline`. After the deadline, the next attempted fire",
        "becomes terminal without executing.",
        "",
        "Both repeating cadences honor `min_interval_secs` between consecutive",
        "fires, so the keeper can't compress a `Repeat { total: 10 }` into a",
        "burst of 10 transactions in a single second."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "once"
          },
          {
            "name": "repeat",
            "fields": [
              {
                "name": "total",
                "type": "u32"
              }
            ]
          },
          {
            "name": "until",
            "fields": [
              {
                "name": "unixDeadline",
                "type": "i64"
              }
            ]
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
          },
          {
            "name": "treasury",
            "docs": [
              "Destination for `close_fee_lamports` when an automation is closed.",
              "Initialized to `admin` at config-create time; rotatable via",
              "`update_treasury`. Kept separate from `admin` so a treasury",
              "rotation doesn't require a fresh upgrade-authority key."
            ],
            "type": "pubkey"
          },
          {
            "name": "closeFeeLamports",
            "docs": [
              "Protocol fee deducted from each close (in lamports, native SOL).",
              "Comes from above-rent-exempt PDA lamports — never touches the",
              "owner's SPL deposit. `0` = full refund. Capped at",
              "`MAX_CLOSE_FEE_LAMPORTS` by `update_close_fee`."
            ],
            "type": "u64"
          },
          {
            "name": "shutdown",
            "docs": [
              "Terminal kill-switch flag. Once true:",
              "* `execute_*` and `create_automation_*` revert",
              "* `update_treasury`, `update_close_fee`, `update_admin`,",
              "`migrate_config` revert",
              "* `admin_close_automation*` becomes callable (admin OR owner",
              "signs; deposit → owner, all other lamports → treasury)",
              "One-way: `set_shutdown` itself rejects when already true. The",
              "flag exists to bound a compromised-admin blast-radius post-",
              "shutdown — once set, the only thing the admin can still do is",
              "accelerate user-PDA closures and rotate the keeper (harmless",
              "since execute_* are blocked)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "swapAccountMeta",
      "docs": [
        "Mirror of Solana's `AccountMeta` flags, serialized over the wire so",
        "the keeper can describe each relayed account's role without us",
        "having to introspect AccountInfo flags (which on Solana would",
        "require trusting the runtime's view, not the inner ix's view)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isSigner",
            "type": "bool"
          },
          {
            "name": "isWritable",
            "type": "bool"
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
            "name": "assetPrice",
            "fields": [
              {
                "name": "feed",
                "docs": [
                  "32-byte feed identifier. Interpretation depends on `source`:",
                  "Pyth feed id (PYTH), SPL mint (JUPITER), …"
                ],
                "type": "pubkey"
              },
              {
                "name": "quoteMint",
                "docs": [
                  "Optional quote mint. `None` denominates in USD (single-feed",
                  "price). `Some(spl_mint)` makes this a base/quote comparison;",
                  "the keeper probes Jupiter for the quote mint's USDC price",
                  "at evaluation time."
                ],
                "type": {
                  "option": "pubkey"
                }
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
                  "Threshold value scaled to `10^expo`."
                ],
                "type": "i64"
              },
              {
                "name": "expo",
                "docs": [
                  "Decimal exponent applied to the threshold. Must be ≤ 0."
                ],
                "type": "i32"
              },
              {
                "name": "source",
                "docs": [
                  "`oracle_source::PYTH`, `oracle_source::JUPITER`, … The keeper",
                  "dispatches to the matching adapter; on-chain is oracle-agnostic."
                ],
                "type": "u8"
              }
            ]
          }
        ]
      }
    }
  ]
};
