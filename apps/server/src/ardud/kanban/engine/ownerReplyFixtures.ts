// Owner replies read from the card discussions on 13 Nov 2026.
export const ownerReplyFixtures = [
  {
    card: 556,
    text: "No, pools may be moved to zero temporarily and then brought back up",
    ask: {
      id: "q1",
      text: "While a model's pool sits at 0, what should happen to cards and delegations that ask for that model?",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-05T22:07:09.486Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Run on the board default meanwhile",
          detail:
            'While the pool is at 0, a card saved on that model runs on the board default (Sol xhigh) and gets a note: "<model> pool at 0; ran on <default>". Reviews work the same way.',
          recommended: true,
          consequence:
            "Work keeps moving during a pause. Cards go back to their own model once you raise the pool. The packet stays as written, with only the event text changed.",
        },
        {
          id: "o2",
          label: "Wait until the pool is back",
          detail:
            'While the pool is at 0, cards saved on that model don\'t start. They show as held with "<model> pool at 0" and start on their own model once you raise the pool. Reviews wait the same way.',
          consequence:
            "Nothing runs on a model you didn't pick. But cards saved on that model, such as the 98 Crpko cards on Terra, sit idle until you raise the pool or change their model. I rewrite the packet to hold instead of fall back.",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 618,
    text: "Is this still relevant?",
    ask: {
      id: "q1",
      text: "I read this as a Robob bug (task_cancel leaves the parent's own queued follow-ups held on the child), not a problem with the OpenCode driver or Haiku max, so #618 changes only task_cancel and Haiku max routing stays as it is (that question stays on #542). Is that right?",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-07T06:03:45.988Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Yes, that's right",
          detail: "Fix task_cancel only; Haiku max routing stays; #542 keeps that question.",
          recommended: true,
          consequence: "The card runs as packeted when the dispatcher picks it.",
        },
        {
          id: "o2",
          label: "Not quite",
          detail: "Tell me what to change in the reading.",
          consequence: "I rework the packet before it runs.",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 618,
    text: "Is this still relevant?",
    ask: {
      id: "q1",
      text: "I read this as a Robob bug (task_cancel leaves the parent's own queued follow-ups held on the child), not a problem with the OpenCode driver or Haiku max, so #618 changes only task_cancel and Haiku max routing stays as it is (that question stays on #542). Is that right?",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-07T06:03:45.988Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Yes, that's right",
          detail: "Fix task_cancel only; Haiku max routing stays; #542 keeps that question.",
          recommended: true,
          consequence: "The card runs as packeted when the dispatcher picks it.",
        },
        {
          id: "o2",
          label: "Not quite",
          detail: "Tell me what to change in the reading.",
          consequence: "I rework the packet before it runs.",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 653,
    text: "Anyone can start a card discussion evaluator",
    ask: {
      id: "q1",
      text: "Anyone can still start a card discussion's evaluator. I'll stop the loop by making the first one stick: it's saved instead of killed by unrelated board changes, later posts go to it instead of spawning another, and the \"now has its own evaluator\" notice goes out once, after the save, without asking old evaluators to post. Is that right?",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-08T00:12:02.639Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Yes, go",
        },
        {
          id: "o2",
          label: "Change",
        },
        {
          id: "o3",
          label: "Drop",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 877,
    text: "When this happens, leave it. Its good that it fails loudly",
    ask: {
      id: "q1",
      text: "Should I drop #877, so a Claude session that Anthropic's filter refused keeps failing with the 4.8 error instead of quietly switching back to Opus 5.5?",
      blocking: true,
      by: {
        _tag: "owner",
      },
      at: "2026-11-10T02:00:15.313Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Drop #877",
          detail:
            "Refused sessions keep failing loudly; #809 still makes the message say it was a refusal",
          recommended: true,
          consequence: "I close #877 and point the scope note on #809 back at #809",
        },
        {
          id: "o2",
          label: "Drop #877 and #809",
          detail:
            'Leave both the failure and its current "model isn\'t available" wording as they are',
          consequence: "I close both",
        },
        {
          id: "o3",
          label: "Keep #877",
          detail: "Build the switch back to Opus 5.5 after all",
          consequence: "The card runs on Sol xhigh as written",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 542,
    text: "Change the board writer / helper on all boards to Sonnet 5.5 Medium",
    ask: {
      id: "q1",
      text: 'I read your note as: on every board, the writer and helper children the evaluator starts (now "Haiku 5.5 max") run on Sonnet 5.5 at medium effort instead, and Haiku drops out of that job. Is that right?',
      blocking: true,
      by: {
        _tag: "owner",
      },
      at: "2026-11-05T16:24:40.658Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Yes, writers and helpers only",
          detail:
            "Writer/helper children on every board move from Haiku 5.5 max to Sonnet 5.5 medium; the board manager stays on Haiku 5.5 xhigh.",
          recommended: true,
          consequence:
            "I write the packet and show you the before/after for each board before anything changes.",
        },
        {
          id: "o2",
          label: "Yes, and the board manager too",
          detail:
            "Same as above, and the board manager also moves from Haiku 5.5 xhigh to Sonnet 5.5 medium.",
          consequence:
            "The packet covers the manager model on every board too; before/after shown to you first.",
        },
        {
          id: "o3",
          label: "Not quite",
          detail: "Tell me what's different.",
          consequence: "I rewrite the plan from your note and ask again.",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 542,
    text: "Use computer use to handle it",
    ask: {
      id: "q3",
      text: "Computer use finished 4 of the 5 boards. Can you do BTSE's two edits in the app? Computer use can't run again until a stuck lock on the desktop is cleared.",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-12T06:52:47.220Z",
      seq: 1,
      closedAt: null,
      respond: {
        task: {
          steps: [
            {
              text: "BTSE → Settings → Models → Board manager: Claude Sonnet 5.5, Reasoning Medium.",
            },
            {
              text: "BTSE → Settings → Instructions → Model routing: make Edit A and Edit B, then click outside the box.",
            },
          ],
        },
      },
    },
    expected: "text",
  },
  {
    card: 542,
    text: "Try BTSE board again with Computer Use",
    ask: {
      id: "q3",
      text: "Computer use finished 4 of the 5 boards. Can you do BTSE's two edits in the app? Computer use can't run again until a stuck lock on the desktop is cleared.",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-12T06:52:47.220Z",
      seq: 1,
      closedAt: null,
      respond: {
        task: {
          steps: [
            {
              text: "BTSE → Settings → Models → Board manager: Claude Sonnet 5.5, Reasoning Medium.",
            },
            {
              text: "BTSE → Settings → Instructions → Model routing: make Edit A and Edit B, then click outside the box.",
            },
          ],
        },
      },
    },
    expected: "text",
  },
  {
    card: 719,
    text: "Is this still relevant?",
    ask: {
      id: "q1",
      text: "I read Crpko #2686's \"requested opencode Haiku max, got claudeAgent Haiku max\" as the harness migration working as designed (every opencode cc/ request now runs on native Claude), so the fix is only to make delegate_task say it remapped, not to bring back the OpenCode route. That changes nothing in routing; later I'd show you a before/after to change the boards' Haiku line to the native id. Is that right?",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-08T19:25:26.622Z",
      seq: 1,
      closedAt: null,
      options: [
        {
          id: "o1",
          label: "Yes, just add the notice",
          detail:
            "Routing unchanged; delegate_task's result names what was asked for and that it was mapped to native Claude.",
          recommended: true,
          consequence:
            "The packet runs as written; the board Haiku-line change comes to you later as a separate before/after.",
        },
        {
          id: "o2",
          label: "No, keep a real OpenCode route",
          detail: "Explicit opencode targets should run on OpenCode, not be remapped.",
          consequence:
            "The packet is rewritten to add an opt-out (e.g. an exact-target flag) or to stop mapping explicit opencode ids; overlaps #880.",
        },
      ],
    },
    expected: "text",
  },
  {
    card: 1155,
    text: "Drop",
    ask: {
      id: "q2",
      text: "OK to add this rule to card-vault and fix the Bupa line?",
      blocking: false,
      by: {
        _tag: "owner",
      },
      at: "2026-11-12T20:16:42.623Z",
      seq: 1,
      closedAt: null,
      respond: {
        verdict: true,
      },
    },
    expected: "rejected",
  },
] as const;
