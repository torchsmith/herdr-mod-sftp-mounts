# SFTP mounts: read before touching anything here

Every folder beside this file is a **live server**, mounted over SFTP by rclone
(`rclone nfsmount`, managed by Herdr's `sftp-mounts` mod and SFTP panel). Often
it is a production website. This file sits outside the mounts and is never
uploaded.

## Saving is deploying

- A file uploads as soon as it is closed after writing. There is no staging,
  no review, no build step, no undo. Every save goes live within a second or two.
- Each save uploads the **whole file**. A half-finished edit is live until the
  next one: make each write complete and valid on its own. For changes that
  span several files, write the ones nothing depends on yet first, the files
  that switch them on last.
- Deletes, renames and moves happen on the server at once and are permanent.
- Last write wins. Someone else (a CMS, another person, a deploy) may be
  editing the same files; nothing locks or merges.

## Before editing

- Back up each file before its first change, **outside** the mount:
  `mkdir -p ~/sftp-backups/<remote>/<date> && cp <file> ~/sftp-backups/<remote>/<date>/`.
  Tell the user where the backups are.
- Ask the user before deleting, renaming, mass-editing, or changing config
  (`wp-config.php`, `.htaccess`, `.env`, anything with credentials or routing).
- If the task is big, suggest copying the site locally, working there, and
  uploading the result, instead of editing live.

## Don't

- Don't create scratch, temp, log, `.bak`, or test files inside a mount. In a
  web root they are public. Use the backup folder or `$TMPDIR`.
- Don't `git init`, `npm install`, `composer install`, or run builds inside a
  mount: they write thousands of files to the server (and a `.git` folder in a
  web root leaks the site's history and secrets).
- Don't print or copy credentials you find (database passwords, API keys,
  salts) into chat, commits, or other files.
- Don't `umount`, kill rclone, or change the rclone config. A plain `umount`
  can drop an upload still in flight. Mounting is the user's job (Herdr's SFTP panel).

## How it behaves

- There is **no shell on the server**. Commands you run (`php`, `wp`, tests,
  linters) run on this Mac against files read over the network, not on the server.
  You can't restart services, read server logs, or query the database from here.
- Reading is a network transfer: `grep -r` or `find` over a whole site
  downloads every file and is slow. Search a specific subfolder.
- Folder listings are cached about 10 s, so changes made elsewhere show up late.
- macOS may briefly create `._name` files next to ones you write. They are removed
  automatically; leave them alone.
- An I/O error or a hang usually means the connection dropped. Stop and tell the
  user. Don't retry writes blindly. The mount's log is `hc read sftp-<remote>`.
- The folder name is the rclone remote name; `rclone config show <remote>`
  gives its host (it also prints an obscured password, so don't echo that output).
