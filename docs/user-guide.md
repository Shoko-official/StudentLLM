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

To import a whole folder of course files at once (one course per file, grouped by chapter), use **Import folder** in the left column.

## 3. Importing material

Click **Import file** and choose one or several files. What happens depends on the type:

| You import | What you get | Needs |
| --- | --- | --- |
| Text (`.txt`) and Markdown (`.md`) | The text appears in the notes immediately. Markdown keeps its headings, lists and tables. | Nothing |
| PDF, Word (`.docx`), PowerPoint (`.pptx`), HTML, RTF | The text is extracted page by page and added to the notes. | The document service |
| Images (photos of a board, scans) | The text in the picture is read and added to the notes. | The document service |
| Audio (`.mp3`, `.wav`, `.m4a`, ...) | The speech is transcribed and added to the notes. | The speech service |

Good to know:

- **The original is always kept first.** Even if reading it fails, the file appears in **Sources** and you can try again later, for example after starting the missing service. Nothing is thrown away.
- **Empty files are refused**, and importing the same file twice into one course is refused (it would only duplicate the notes). The same file in two different courses is fine.
- **Password-protected or damaged PDFs** are saved but cannot be read. Remove the password and import a fresh copy.
- **Size limits**: 250 MB for audio, 100 MB for documents, 50 MB for images and 10 MB for text files.
- **Closing the window during an import** asks you to confirm, because a running import or transcription would be interrupted.
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

- **Chat** answers from your notes and sources and shows chips under each answer. Click a chip to open the original source, at the right page when there is one. If the model is not reachable you get a message saying so and your question stays in the box so you can send it again.
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

- In a browser, in that browser's storage for this address. A different browser, a private window, or another address (for example another port) sees an empty workspace. Clearing the site's data in your browser **deletes all your courses**.
- In the desktop app, the course text is in a database file in the app's data folder, and the original files and recordings are in the app's own browser storage. Typical locations are `%APPDATA%\com.shoko.studentllm` on Windows, `~/Library/Application Support/com.shoko.studentllm` on macOS and `~/.local/share/com.shoko.studentllm` on Linux. These paths were not verified on every system.

**Back up with Export.** Open the course, choose **More → Export course**. You get one `.studentllm.json` file containing the notes, the original files and the audio. Keep it somewhere safe (not only on the same computer). To restore it, click **Import course** (bottom of the left column). Do this for every course you care about, especially before reinstalling, cleaning your browser or changing computers. A course larger than 256 MB can be exported but cannot be imported back; the app warns you.

**Uninstall and wipe.** Deleting a course (**More → Delete course**) erases it and its files. Uninstalling the desktop app removes the program but may leave the data folders above on disk; delete them yourself if you want everything gone. Export first if you want a copy.

**Do not open StudentLLM in two tabs or windows at once.** If another tab changes your workspace, the first tab stops saving and shows a message asking you to reload, so it cannot overwrite the newer work. The desktop app does not yet prevent a second window from being started.

## 9. Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| "The AI model is not reachable" | LM Studio is closed, has no model loaded, or its server is off. | Start LM Studio, load a model, switch on the local server (and CORS for the desktop app). Open Settings to check. |
| A PDF or image is saved but "could not be read" with "The document service is offline" | The document service is not running. | Start it, open Settings, click **Refresh local services**. Existing files stay in Sources. |
| The same, with "damaged or protected by a password" | The file itself cannot be read. | Remove the password or export a fresh copy, then import it again. |
| A recording is in Sources but has no text | The speech service was not running. | Start it, then click **Transcribe** on the recording. |
| "Your changes are not being saved" | The browser's storage is full or blocked. | Click **Export this course** to keep a copy, then free up space or delete old courses. In a private window, storage is often blocked. |
| "StudentLLM was changed in another tab or window" | You have it open twice. | Click **Reload**. Close the extra tab. |
| "Your saved workspace could not be read" | The stored data was damaged, or written by a newer version. | A copy was kept in the browser's storage. Courses you exported are unaffected: import them. Report it (below) before clearing the browser's data. |
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
