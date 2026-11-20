# Task 84 — An MF4's Embedded Databases Decode Its Frames

> Opened by owner ruling 2026-08-16. Groomed with the owner
> 2026-11-20; in progress.

## Problem

An MF4 can carry the databases it was recorded against as `##AT`
attachments. Import parses them into the loaded set under
`<capture>#<attachment name>`, but nothing follows from that:

- **They decode nothing.** A database assigned to no bus applies to no
  frame, an embedded one is installed assigned to nothing, and the only
  place a bus is assigned — the project panel's DBC list — never learns
  it exists.
- **They leak.** The frontend's DBC list is replaced by the host's whole
  set on the next add, remove or window reload. From then on the
  embedded database is in the project's list, and a save writes its
  `#` identity into the project file as a path that cannot be read back.
- **Reload DBCs drops them**, because it re-reads every listed path from
  disk.
- **Save Capture to MDF drops them**, because it reads each attachment's
  bytes back from disk by path.

## Design (owner rulings, 2026-11-20)

- **Assignable, not saved.** A capture's databases appear in the project
  panel's DBC list, marked as the capture's, with the ordinary bus
  assignment. They are never written into a project file.
- **The import dialog assigns.** It lists the capture's databases beside
  the channel → bus rows, and each is assigned to the buses chosen
  there. Nothing is assigned that the dialog did not say.
- **A file may say which channels a database is for**, and the dialog
  starts from what it says. The one way read is the one python-can
  writes and asammdf decodes by: a frame group's `CAN_DataFrame`
  channel links the attachment (`cn_at_reference`). It ties a database
  to a channel *group*, so what it names is the bus channels that
  group's frames were recorded on. cannet invents no mechanism of its
  own. A file that links nothing says nothing.
- **The dialog is the channel-mapping dialog**, with a *Databases*
  section under the channel rows when the capture carries any: one row
  per database with a bus picker (several buses, or none). A row starts
  on the buses its named channels are mapped to, follows the channel
  rows until the user changes it, and is inert while *CAN messages* is
  unticked.
- **Restore brings them back.** A session restored from an MF4 that was
  opened with no project, or a temporary one, restores the capture's
  databases and their bus assignments. An MF4 with databases reads as a
  project: its channels are buses, its attachments the DBC list.

### Open with the owner

- The dialog's starting assignment for a database the file names no
  channel for. Assumed until ruled: the one mapped bus when the file has
  a single channel, unassigned otherwise.
- Whether Save Capture to MDF should say which bus each database is
  assigned to. The convention can only say it per frame group, and the
  writer puts every channel's frames in one group, so saying it means
  writing one `CAN_DataFrame` group per bus channel.

## Phases

1. **The MDF crate reads the channel reference.** A channel block with
   attachment links parses (its fixed fields sit after a variable link
   list), and the census reports each attachment with the bus channels
   the capture names for it.
2. **Host.** The scan the dialog reads carries the databases and their
   channels; the import takes the dialog's assignments; a capture's own
   databases survive a re-export.
3. **Frontend.** The dialog's database rows; the project panel lists
   capture databases as assignable and unsaved; Reload DBCs and project
   save leave them alone.
4. **Restore.** A capture-only session restores its databases and
   assignments.

## Out of scope

- Name-matching file-backed signals against DBC definitions, and enum
  labels for file-backed content resolving through the capture's own
  database. Both wait on this task and are not part of it.
- Extracting an embedded database to disk.

## Exit criteria

- Importing an MF4 whose frame channel links a database opens the
  dialog with that database assigned to the buses its channels map to;
  importing decodes the frames with it.
- An MF4 that links nothing imports with whatever the dialog assigned.
- Save Capture to MDF then re-import keeps a capture's own databases.
- A project saved after an MF4 import names no capture database.
- Reload DBCs keeps a capture database loaded and assigned.
- A capture-only session restores with its databases assigned as they
  were.
- README § MDF import and export, `docs/CONTEXT.md` and the MDF crate's
  rustdoc say what the code does.

## Status

- 2026-11-20 — phase 1 done: `cannet-mdf` reads a channel block with
  attachment links and the census reports each attachment's bus
  channels. Checked against an asammdf-written capture and a copy of it
  whose frame channel links its databases; asammdf opens the copy.
- 2026-11-20 — the import assigns: the scan lists the capture's
  databases with their channels, the channel-mapping dialog has its
  *Databases* section, and `import_mdf` assigns each database to the
  buses chosen. Still to do: the project panel listing (and with it the
  leak into a saved project and Reload DBCs), a capture's own databases
  surviving a re-export, and restore.
