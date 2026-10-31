# StudentLLM user guide

StudentLLM keeps one course in one place: the recording of the lecture, the notes it produces, the PDFs and slides you import, and the questions you ask about them. It runs on your computer. This guide is for students, not developers: it tells you what to click, what needs extra software, and what to do when something does not work.

If you want to build or change the app, read [CONTRIBUTING.md](../CONTRIBUTING.md) instead.

## Contents

1. [Install the app](#1-install-the-app)
2. [Your first course](#2-your-first-course)
3. [Importing material](#3-importing-material)
4. [Recording a lecture](#4-recording-a-lecture)
5. [What needs which service](#5-what-needs-which-service)
6. [Asking questions and making study material](#6-asking-questions-and-making-study-material)
7. [Privacy](#7-privacy)
8. [Where your data lives, and how to back it up](#8-where-your-data-lives-and-how-to-back-it-up)
9. [Troubleshooting](#9-troubleshooting)
10. [Reporting a bug without leaking private data](#10-reporting-a-bug-without-leaking-private-data)

## 1. Install the app

You can use StudentLLM in two ways:

- **The desktop app** (Windows, macOS on Apple Silicon, Linux). Download the installer for your system from the [releases page](https://github.com/Shoko-official/StudentLLM/releases). Each release also lists a checksum file (`SHA256SUMS-...`) so you can check that your download is intact.
- **In a browser**, by running it from the source code. That path needs Node.js and is described in the [README](../README.md#quick-start). The rest of this guide applies to both.

### The warning on first launch

The installers are **not yet code signed**, so your system will warn you the first time. This is expected for this release; the warning does not mean the file is damaged. Only continue if you downloaded the installer from the official releases page.

- **Windows.** A blue "Windows protected your PC" window (SmartScreen) appears. Click **More info**, then **Run anyway**.
- **macOS.** A message says the app cannot be opened because the developer cannot be verified. Open **System Settings → Privacy & Security**, scroll to the message about StudentLLM, and click **Open Anyway**. The macOS build only supports Apple Silicon Macs (M1 and later), not Intel.
- **Linux.** Install the `.deb` package with your package manager, for example `sudo apt install ./StudentLLM_*.deb`.

## 2. Your first course

When you open StudentLLM for the first time the library is empty. That is normal.

1. Click **Quick start** (left, top). It creates a blank course right away with a temporary name such as "Study course · 5AB8". Or click **New course** to choose the name, subject and chapter yourself.
2. Add material with **Record** (a lecture) or **Import file** (notes, PDFs, slides, images, audio).
3. Open the four tabs of the course:
   - **Notes**: the written notes built from what you recorded or imported.
   - **Sources**: the original files and recordings. They are never replaced.
   - **Chat**: ask questions about the course.
   - **Study**: generate a summary, guide, quiz, flashcards, concept map or glossary.
4. Rename and file the course later: **More → Edit course**, or **More → Organize material with AI** to get a suggested name and place (this one needs the AI model, see [section 5](#5-what-needs-which-service)).

To import a whole folder, open the course that should receive it and use **Import folder** in the left column. All supported files are added as sources of that one course, in reading order. An empty library creates one course named after the folder. Imports run one file at a time; **Stop after this file** leaves the remaining files untouched. After an interruption, import the folder again: files already in that course are detected by their content and skipped.

## 3. Importing material

Click **Import file** and choose one or several files. All selected files stay in the open course, including if you browse another course while they are being processed. Ordinary imports and retranscription never let AI create or choose another course; use **More > Organize material with AI** when you want to review a placement proposal. What happens depends on the type:

| You import | What you get | Needs |
| --- | --- | --- |
| Text (`.txt`) and Markdown (`.md`) | The text appears in the notes immediately. Markdown keeps its headings, lists and tables. | Nothing |
| PDF, Word (`.docx`), PowerPoint (`.pptx`), HTML, RTF | The text is extracted page by page and added to the notes. | The document service |
| Images (photos of a board, scans) | The text in the picture is read and added to the notes. | The document service |
| Audio (`.mp3`, `.wav`, `.m4a`, ...) | The speech is transcribed and added to the notes. | The speech service |

Good to know:

- **The original is always kept first.** Even if reading it fails, the file appears in **Sources** and you can try again later, for example after starting the missing service. Nothing is thrown away.
- **Empty files are refused**, and importing the same file twice into one course is refused (it would only duplicate the notes). The same file in two different courses is fine.
- **Password-protected or damaged files** are saved but may not be readable: try a fresh copy without a password.
- **Size limits**: 250 MB for audio, 100 MB for documents, 50 MB for images and 10 MB for text files.
- **Closing the browser tab during an import, a transcription or a recording** asks you to confirm, because the work would be interrupted. The desktop app may close without asking (not verified).
- **Drag and drop** (dropping files onto the page) works in the browser. On the desktop app use **Import file** instead: the desktop window may handle dropped files itself (not verified).
- To get rid of a source, use **Remove** in Sources. You have a few seconds to click **Undo**. After that the stored original is erased.

## 4. Recording a lecture

1. Open the course, click **Record**. The first time, a notice explains that you must only record people who know about it and agree. Tick the box and continue. This is your responsibility, not the app's.
2. Your browser or system asks for **microphone permission**. Allow it. If you blocked it by mistake, allow the microphone for StudentLLM in your browser settings (or in your system's privacy settings for the desktop app), then try again.
3. Use **Mark passage** during the lecture to flag a moment you want to review.
4. Click **Stop recording**. The audio is saved on this computer first. If the speech service is running, it is then transcribed and added to the notes. If it is not, the recording simply waits in **Sources**: use **Transcribe** there whenever the service is available.

If something goes wrong while recording:

- **The microphone is unplugged or its permission is withdrawn.** The recording ends on its own, saves what was captured, and tells you why.
- **The browser or computer closes mid-lecture.** The audio is saved in small pieces every second. The next time you open StudentLLM, the interrupted recording is recovered into its course, and you are told so.
- **Storage fills up.** You are warned while you record. Stop, and free some space before the next recording.

## 5. What needs which service

In the development web app, Settings also offers optional NVIDIA NIM cloud models. **Connected** means the chosen model answered a short connection test. The suggested model is Nemotron 3.5 Lightning. If a different model is retired or does not answer in time, StudentLLM tests the suggestion before switching and tells you what changed; a key or quota error keeps your selection. The connection test contains no course material. While NIM is selected and saved, course work uses NVIDIA as explained in the consent notice. See [Provider configuration](providers.md#nvidia-nim-in-the-development-app).

PDF and image extraction stays local by default. For complex scans, handwriting, formulas, tables or diagrams, the development app also offers **Sources > Read with NVIDIA** on an individual file. It asks before sending that file's page images to NVIDIA. The transcription is marked for review and kept beside the original, in the same course. You can cancel analysis; errors keep your earlier notes. This image-analysis choice is separate from the chat provider. See [document analysis limits](local-documents.md#analyze-a-source-with-nvidia).

StudentLLM does the following by itself, with nothing else installed: create courses, record audio, import text and Markdown, search, take notes, export and import courses.

Three optional helpers add more. They are separate programs that run on your computer. Setting them up currently takes some technical steps (see [Provider configuration](providers.md), [Local transcription](local-asr.md) and [Local document extraction](local-documents.md)); the desktop app does not include them yet.

| Helper | It adds | If it is not running |
| --- | --- | --- |
| **AI model** (LM Studio or another compatible local server) | Chat answers, Study material, the AI organizer, rewritten notes. | Chat, Study and the organizer say the model is not reachable. Your notes and sources are unaffected. A search over your courses still works. |
| **Speech service** | Transcribing recordings and audio files. | Audio is saved and waits to be transcribed. |
| **Document service** | Reading PDFs, Office files and images. | The files are saved and wait to be read. |

**Settings** (the sliders icon, top right) shows which helpers are running. To use LM Studio: start it, load a model, switch on its local server, and for the desktop app also switch on **Enable CORS** in its server settings. Then open Settings and click **Save connections**.

The desktop app only talks to services on your own computer (`localhost` or `127.0.0.1`). It refuses addresses on the network or the internet; if you need a remote model, run a local proxy on your computer.

## 6. Asking questions and making study material

- **Chat** answers from your notes and sources and shows chips under each answer. Click a chip to open the original source, at the right page when there is one. The conversation scrolls above a multiline question box: **Enter** sends, and **Shift+Enter** adds a line. The source count opens a shortcut to the course sources. If the model is not reachable you get a message saying so and your question stays in the box so you can send it again.
- **Study** builds a summary, guide, quiz, flashcards, concept map or glossary from what the course contains. Nothing is saved if the model fails, and no empty placeholder is created.
- Answers come from a model and can be wrong. Check important facts against the source chips.

## 7. Privacy

- Everything runs on your computer by default. In local mode StudentLLM sends nothing to the internet. Your courses, recordings and files stay in this app.
- There is no account and no cloud storage in this version.
- Your questions, notes and transcripts go to the AI model you configured. With LM Studio that is a program on your own computer.
- The development build offers an optional cloud provider (NVIDIA NIM). If you choose it in Settings, your transcripts, imported text, notes and questions are sent to NVIDIA until you switch back. The packaged desktop app does not offer it.
- Recording other people is regulated. Only record people who have been told and agreed.
- If you delete a course, its stored files and recordings are erased with it, unless the same file is still used by another course.

## 8. Where your data lives, and how to back it up

Your data is stored **on this computer only**:

- In a browser, in that browser's storage for this address. A different browser, a private window, or another address (for example another port) sees an empty workspace. Clearing the site's data in your browser **deletes all your courses**. Recent versions keep the workspace in the browser's **IndexedDB**, which has room for far larger courses than the 5 MB the older storage allowed. Open **Settings** to see how much of the browser's storage is used (you are warned at 80%). **Settings** also shows whether the browser has promised to keep your data when it runs short of space, and has a button to ask it to (some browsers, Firefox for instance, then show their own prompt). This protects against automatic clean-up only, not against clearing the site's data by hand. Safari may delete the data of a site you have not opened for about a week, unless you add it to your Dock or Home Screen: export the courses you care about.
- **A workspace has a size limit of 16 MB** (the text of your notes, transcripts and chat, not the original files and recordings, which are stored separately). Past it, StudentLLM says "larger than the 16 MB limit" and stops saving new changes. Use **More → Export course** to keep a copy, then split the material into smaller courses or delete old ones.
- **If the workspace comes back empty or older than you expect**, StudentLLM tells you when it knows why ("Your workspace storage was reset", "...was cleared"): the browser or someone cleared the site's data. If a copy of the older workspace was still there, it is shown with its date and **Download saved copy**. Courses you exported can always be imported again.
- **After upgrading from an older version**, your existing workspace is copied to the new storage the first time you open the app. The copy is checked before it is used, and the old copy is left where it was, unchanged, as a fallback for at least one more release; it is not updated afterwards. If the old copy later turns out to differ from the migrated one (for example because an older version of the app was opened in between), StudentLLM keeps it and tells you; **Download older copy** saves it.
- **If the browser blocks IndexedDB** (some private windows and privacy modes do), StudentLLM says so and uses the smaller older storage instead. Long lectures may then stop being saved; you would see "Your changes are not being saved". Use a normal window for long courses. If IndexedDB held your workspace before and cannot be opened now, StudentLLM shows the last older copy with **saving paused** so that nothing is overwritten: close other StudentLLM tabs, reload, and export what you need first.
- In the desktop app there are two places. The course text and notes are in a database file in the app's data folder. The original files, the recordings and the copies described below are in the app's embedded browser storage, in a second folder. Typical locations, **not verified on every system**:

  | System | App data folder (course text) | Embedded browser storage (originals, recordings, saved copies) |
  | --- | --- | --- |
  | Windows | `%APPDATA%\com.shoko.studentllm` | `%LOCALAPPDATA%\com.shoko.studentllm` (the `EBWebView` folder inside) |
  | macOS | `~/Library/Application Support/com.shoko.studentllm` | `~/Library/WebKit/com.shoko.studentllm` |
  | Linux | `~/.local/share/com.shoko.studentllm` | `~/.local/share/com.shoko.studentllm` and `~/.cache/com.shoko.studentllm` |

**If StudentLLM cannot read your saved workspace.** It says so at the top of the window and never silently throws the data away. When the data is damaged it keeps a copy inside the browser storage above. When no copy can be kept (the browser storage is full), or a newer version of the app wrote the data, it leaves the saved data untouched and **pauses saving in that window**, so nothing you do there is kept: use **Download saved data**, or open the data with a newer version. **Download saved copy** or **Download saved data** gives you a `studentllm-workspace-saved-copy.json` file. It is a raw copy of the workspace, not a course export, so **Import course** cannot read it; keep it safe and send it to the maintainers if you need help restoring it (see section 10, and do not post it publicly because it contains your course text).

**Back up with Export.** Open the course, choose **More → Export course**. You get one `.studentllm.json` file containing the notes, the original files and the audio. Keep it somewhere safe (not only on the same computer). To restore it, click **Import course** (bottom of the left column). Do this for every course you care about, especially before reinstalling, cleaning your browser or changing computers. A course larger than 256 MB can be exported but cannot be imported back; the app warns you.

**Interrupted recordings.** Settings can remove an unrecovered recording whose course is missing only after the workspace loaded safely, saving is working, and the recording is at least a day old. Recent recordings are kept because another tab may still be recording. Before confirming removal, check that no other tab or window needs the audio; removal is permanent. The age check is a precaution, not proof that a recording has stopped.

**Temporary recovery information.** If the smaller local storage is full or blocked, recovery information may only last for the current browser session. A banner warns you: finish and save the recording before closing the tab or browser. Its audio may remain stored without the information needed to find it automatically.

**Recovery copy limit.** StudentLLM keeps at most eight older recovery copies. If another different older workspace is found after that limit, a banner offers **Download older copy** directly from the fallback data. Existing copies and the current workspace are kept.

**Uninstall and wipe.** Deleting a course (**More → Delete course**) erases it and its files. Uninstalling the desktop app removes the program but may leave the data folders above on disk; delete them yourself if you want everything gone. Export first if you want a copy.

**Do not open StudentLLM in two tabs or windows at once.** If another tab changes your workspace, the first tab stops saving and shows a message asking you to reload, so it cannot overwrite the newer work. The desktop app runs only one window per user: starting StudentLLM again (from the shortcut, for example) brings the existing window to the front instead of opening a second one, so two copies cannot overwrite each other's work. If you start it again and nothing seems to happen, look for the existing window in the taskbar or dock.

## 9. Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| "The AI model is not reachable" | LM Studio is closed, has no model loaded, or its server is off. | Start LM Studio, load a model, switch on the local server (and CORS for the desktop app). Open Settings to check. |
| A PDF or image is saved but "could not be read" with "The document service is offline" | The document service is not running. | Start it, open Settings, click **Refresh local services**. Existing files stay in Sources. |
| The same, with "could not process this file" | The file may be damaged or password-protected, or the service lacks a component such as OCR (the service reports both the same way). | Try a fresh copy without a password. If other files fail too, look at the service window for an error message. |
| A recording is in Sources but has no text | The speech service was not running. | Start it, then click **Transcribe** on the recording. |
| "Your changes are not being saved" | The browser's storage is full or blocked. | Click **Export this course** to keep a copy, then free up space or delete old courses. In a private window, storage is often blocked. Removing a source or deleting a course while this is shown keeps the stored files until the changes can be saved, so a reload does not find sources without their files. |
| "This browser does not let StudentLLM use the storage meant for large courses" | IndexedDB is blocked (often a private window). | Use a normal window for long courses. Export what you care about. |
| "StudentLLM could not open the storage that holds your workspace" | IndexedDB is blocked or held by another tab. Saving is paused. | Close other StudentLLM tabs and click **Reload**. Export first if you need to keep what you did here. |
| The screen stays on "Opening your workspace..." | The browser's storage did not answer, often because another StudentLLM tab or window is holding it. After about 8 seconds a **Reload** button appears; after about 20 seconds StudentLLM gives up on that storage and opens the smaller fallback with a message. | Close other StudentLLM tabs and windows, then **Reload**. Export first if the fallback opened. |
| "Saving is paused in this window, so the course was not deleted" | Another tab owns the workspace, or the saved data is protected. | Reload, then delete the course. |
| "larger than the 16 MB limit" | The notes and chat of the workspace grew past the limit. | Export the course, then split the material or delete old courses. |
| "Browser storage is almost full" (in Settings) | 80% of the space the browser gives this site is used. | Export the courses you want to keep, then delete old courses or free up disk space. |
| "StudentLLM was changed in another tab or window" | You have it open twice. | Click **Reload**. Close the extra tab. |
| "Your saved workspace could not be read", "...left out" or "...newer version" | The stored data was damaged, partly unreadable, or written by a newer version. | Click **Download saved copy** or **Download saved data** and keep the file. Courses you exported are unaffected: import them. Do not clear the browser's data before you have the file. See section 8. |
| "Microphone access is blocked" | Permission was refused. | Allow the microphone for StudentLLM in your browser or system settings. |
| "No microphone was found" | No input device. | Plug one in or pick one in your system sound settings. |
| Search misses a word | Search ignores accents and capital letters, but not different words. | Try a shorter or different word. |
| The app is slow with a very long lecture | Hundreds of passages are drawn at once. | Keep the Transcript section closed unless you need it, and split very long recordings into several courses. |

## 10. Reporting a bug without leaking private data

Report bugs at [github.com/Shoko-official/StudentLLM/issues](https://github.com/Shoko-official/StudentLLM/issues). Security problems go through the private channel described in [SECURITY.md](../SECURITY.md), not a public issue.

A good report has: what you did (numbered steps), what you expected, what happened, the app version (the installer name or release number), and your system (Windows, macOS or Linux, and the browser if you use one).

Your courses are private. **Never attach or paste** lecture audio, course notes, PDFs, a course export, screenshots that show course content, or anything from your Settings that is a key or an address with a password in it. Instead:

- describe the problem in your own words;
- reproduce it with a made-up file, such as a short text you write for the purpose, and share that;
- if you need to show a screen, crop it to the error message or blur the course text;
- remove names, emails and other personal details from any message you copy.

You can leave out anything you are not comfortable sharing; the steps and the exact error message are usually enough.
