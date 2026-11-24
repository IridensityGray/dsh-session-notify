# Conversation pause reminders

When several Harness tasks run at once, you no longer have to open each one to
check its state: whichever conversation pauses, this bundle tells you.

## When it fires

| Alert | Trigger |
|---|---|
| Waiting for a choice | the assistant called the question tool and options are waiting |
| Waiting for approval | a permission or approval prompt is waiting for a decision |
| Turn finished | the assistant stopped running for this turn |
| Waiting for input | the conversation has been idle longer than the configured delay |
| Error / interruption | the turn ended with an error, was aborted, or hit the output limit |

All workspaces and all conversations are watched by default, including
subagent and scheduled-task sessions.

## How it reminds you

1. **On-screen cards**: up to four stack in the top-right corner with the alert
   kind, conversation name and a short summary. "View" jumps to that
   conversation, "×" dismisses the card, and cards disappear after two minutes.
2. **Windows toast + chime**: visible while the app is in the background; the
   sound is one short cue.
3. **Bell in the sidebar footer**: an unread badge counts pending alerts; click
   it to open the settings panel.

## Settings

Bell → settings panel:

- Toggle each alert kind separately.
- How long an idle conversation waits before reminding you (default 5 minutes).
- "Only remind when the window is not in front": on by default, so a focused
  window stays quiet.
- "Only remind for conversations I am not viewing": optional, reduces noise
  further.
- Turn the cards off, keeping only the system notification and sound.
- Four "Test" buttons to verify cards and sounds immediately.

## Limitations

- Toast notifications and the system sound are produced by the Host half
  through PowerShell, so they require the Windows desktop app. A plain browser
  session (`dsh web`) still shows the in-page cards.
- On first use Windows creates a "Harness Notify" Start-menu shortcut to
  register the notification identity.
- With the sidebar collapsed to a narrow rail, only the bell and its badge are
  visible.
- An alert fires at most once per conversation per turn.
- Alerts stop when Harness is closed: the watcher runs in the Host process, so
  a task that finishes after shutdown is not announced afterwards.

## Install

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-session-notify
```

Restart Harness after installing so the Host half is mounted.
