# dsh-session-notify

A DeepSeek Harness bundle that tells you when a conversation pauses, so you do
not have to keep checking every task.

## What it adds

- A **Windows toast** and a short **chime** when a conversation needs you,
  finishes, goes idle, or fails.
- Up to four clickable **cards** in the top-right corner; "View" jumps to the
  conversation.
- A **bell** in the sidebar footer with an unread badge and a settings panel.

## When it fires

| Alert | Trigger |
|---|---|
| Waiting for a choice | the question tool is waiting for an option |
| Waiting for approval | a permission or approval prompt is pending |
| Turn finished | the assistant stopped running |
| Waiting for input | the conversation has been idle past the configured delay |
| Error / interruption | the turn errored, was aborted, or hit the output limit |

By default every workspace and every conversation is watched, including
subagent and scheduled-task sessions.

## Settings

Bell → settings panel: per-kind toggles, idle delay (default 5 minutes),
"only when the window is not in front", "only for conversations I am not
viewing", cards on/off, and four test buttons.

## Limits

- Toast notifications and the system sound come from the Host half through
  PowerShell, so they need the **Windows desktop app**. A plain browser session
  still shows the in-page cards.
- Cards live in the page: close Harness and no watcher remains, so a task that
  finishes after shutdown is not announced.
- Windows creates a "Harness Notify" Start-menu shortcut on first use to
  register the notification identity.

## Install

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-session-notify
```

Restart Harness after installing so the host half is mounted. Notification
preferences are stored per browser in `localStorage`.

## Uninstall

```sh
dsh plugin --profile <profile> remove @iridensity_gray/dsh-session-notify
```

Restart DSH afterwards.

## License

MIT
