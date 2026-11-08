30/10 notes

UI/UX

- session tab redesign: session tabs are moved on the top like browser tabs. and + (new session) button on the right. remove sidebar, no use for it.
- context library new location: context library documents are included at the bottom of the user query text box, in the answer assistant's  window. instead of add files, use + button for local upload from PC.
- settings symbol location: move to top right
- the window UI should match Tern's UI. specifically the tabs at the top. also the top bar of the window of ghst shuoldn't be grey/black with ghst name in the top left. the tabs shuold be there! making it much more minimal. so the tabs are on the same level of the quit/minimise buttons.



Backend AI infra

- remove Persistent omp agent · isolated tools & session component. reasoning: the user shouldn't care about omp's tools at all. i just want the model to be harnessed by omp's clever techniques like snapcompaction, automatically. confirm whethere this is possible. so for each transcription that becomes a user input to the omp session, the model answers it directly in the answer assistant window. every next transcription that will use the same session. when the user creates a new session, that will initiate a new omp session with its own content library files if the user chooses to upload them.



31/10 notes

UI/UX

- [x] completely remove session tabs functionality
- [x] move recording time, zoom output only dropdown and start listening under Live transcript
- [x] make zoom output only dropdown and start listening button of same size
- [x] rename start listening button to "Listen" , also remove the recording dot
- [x] in answer assistant window, fix the positioning of the + button to add reference files to be exactly centered in its square.
- [x] remove "Check answers against your research. Select an inline citation to read its source."

functionality

- [x] completely remove session tabs functionality

* [x] disguise button with eye symbol in settings. to rename process name to a custom name.



6/11

- reshape the user query text box by making it smaller (shorter). "No references attached" and the + button can go under the box.
- when i open the app, the app logo goes from rounded square to square with angles. fix this. should always be roudnded square.
- stage, add and leave an appropriate commit trail following commit conventions to the repo <https://github.com/0xf3dz/ghst>
- then biggest task:
  - design a minimal landing page for the ghst app inspired by the following websites: <https://stencil.so/tern> and <https://omp.sh/>
  - keep it as simple as possible but follow the tern style of website.
  - prompt me when u re doing it to make key decisions on the final outlook
  - the website will be hosted on ghst.f3dz.sh. let me know what u need from me.



9/11

- [x] Improve the question field controls: place the `+` button and reference label on the same row as the shortcut and send button.
- [x] Match the landing page color palette to the application.



* explain form audio segements locally and enconde each segment as a wav file
  - what does this mean and can this be optimised
* search local pdf index and assemble answer context: how is this done? is the pdf chunked and embedded in a vector db and later relevant chunks are reranked and retrieved to return relevant ones to the user query/transcript?
* agent can read extracted references in its workspace? what does this mean?
- "The app makes complete WAV requests for speech segments. It does not send audio as a token stream or identify jury questions."
  - would sending audio as a token stream be better?
  - [x] OpenAI transcription now streams 24 kHz PCM over a local WebSocket with `gpt-live-transcribe`. Local Whisper keeps the complete WAV path. The microphone, system loopback, and Zoom helper paths all use the stream.
- An omp agent can also read the extracted PDF text in its session workspace.
  - [x] Make this the default method and remove BM25 search. PDF references now require an omp answer connection.


