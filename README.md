# BBStreamer

BBStreamer runs on Windows 11 and streams the published BambuBoard scene when your X1C or H2C starts printing. Its local dashboard shows printer state, capture health, and recent broadcasts. Each streamed print gets a new YouTube watch link. The Discord bot posts once YouTube confirms the broadcast and edits that same message as the print progresses or ends.

## Set up Windows

1. Install [Node.js 24](https://nodejs.org/en/download), Chrome or Edge, and a [Windows FFmpeg build](https://ffmpeg.org/download.html#build-windows) with H.264, AAC, and RTMPS. Put FFmpeg on PATH or enter the full executable path in **Settings → Video and performance**.
2. Run [BambuBoard](https://github.com/t0nyz0/BambuBoard) in two instances and publish the layout for each printer. Give the instances separate ports and data directories. Open both published scenes in a browser and check that each shows the intended printer.
3. Double-click [Start.cmd](Start.cmd). It installs the locked npm dependency on first launch and opens [the local dashboard](http://127.0.0.1:8085). From a terminal, you can also run `npm ci --ignore-scripts` followed by `npm start`.
4. In **Settings**, enter each printer’s LAN address, serial number, access code, and published **/live** URL. Save settings, check the printer connection in **Overview**, and select **Preview capture**. Preview uses the same Chromium renderer as the stream and stays on this PC.

### Running two stock BambuBoard instances

For a source installation, run `npm ci` in the BambuBoard checkout, then use a separate PowerShell window for each instance. From that checkout:

```powershell
# X1C window
$env:BAMBUBOARD_HTTP_PORT = '8080'
$env:BAMBUBOARD_DATA_DIR = Join-Path $env:LOCALAPPDATA 'BambuBoard-X1C'
npm.cmd start
```

```powershell
# H2C window
$env:BAMBUBOARD_HTTP_PORT = '8081'
$env:BAMBUBOARD_DATA_DIR = Join-Path $env:LOCALAPPDATA 'BambuBoard-H2C'
npm.cmd start
```

Keep the data directory of an existing installation if it already has a published layout. BambuBoard’s **Setup** saves each instance’s printer settings. The default BBStreamer overlay addresses are `http://127.0.0.1:8080/live` and `http://127.0.0.1:8081/live`. Run both boards at sign-in using your existing BambuBoard setup if you want unattended streaming after a Windows restart.

## Connect YouTube and Discord

- Enable live streaming on your YouTube channel. In [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com), enable **YouTube Data API v3**, set up the consent screen, and create a **Desktop app** OAuth client. Download its JSON file. In BBStreamer Settings, choose that file and select **Connect YouTube**. Sign in to the channel you want BBStreamer to use. The sign-in returns to the same local dashboard. BBStreamer uses the channel’s audience default. Set a channel default in YouTube Studio for unattended broadcasts. An external consent screen in **Testing** can issue refresh tokens that expire after seven days. [YouTube authorization](https://developers.google.com/youtube/data/live/authentication) · [Google refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) · [YouTube channel audience](https://support.google.com/youtube/answer/9527654)
- Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) and install it in your server with the `bot` scope. Give it **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** in the destination text or announcement channel. History lets BBStreamer recover an announcement after a lost response. In Settings, enter the channel ID and paste the bot token. **Check bot connection** reads the bot and channel details. Clear the channel ID to turn off announcements for new broadcasts. [Discord message API](https://docs.discord.com/developers/resources/message)
- Visibility defaults to **Unlisted**. After verifying your captures, turn on **Start broadcasts automatically** and save. This also picks up any print already active. Use a short print on each printer to check that YouTube goes live, Discord receives a link, and the same message updates when the print ends. Confirm that a Discord viewer can open the link with your chosen visibility.

BBStreamer uses the print name and printer in the broadcast title, for example **Wall Mount Bracket | H2C**. For automatic archiving, create a **3D Printing Streams** playlist on the connected channel, set it to **Unlisted** or **Private**, and paste its URL or ID into **Settings → YouTube → Replay playlist**. BBStreamer adds each new broadcast after YouTube completes it. It retries while the replay is processing and keeps the broadcast visibility you selected. An unlisted playlist can be shared by link. [YouTube playlist visibility](https://support.google.com/youtube/answer/3127309)

Printer access codes, the OAuth client and refresh token, and the Discord bot token are encrypted for the current Windows account using Windows DPAPI. Runtime data and the local log live in `%LOCALAPPDATA%\BBStreamer`. YouTube generates the ingest keys. FFmpeg receives its key at run time, where local process inspection can expose it. The dashboard listens on `127.0.0.1` by default and uses the same signed-in Windows account for startup and credential access.

### Open the dashboard on your network

Start BBStreamer with `Start.cmd --lan-address 192.168.1.50`, replacing the address with your PC’s private IPv4 address. Open that address on port 8085 from a device on the same subnet. Devices on that subnet have full dashboard access over HTTP, including settings. Connecting YouTube opens Google sign-in in the PC’s browser. BBStreamer remembers the address after a successful launch. Use `Start.cmd --lan-address off` to switch back to PC-only access. Close an existing BBStreamer process before starting with a different address.

## Start at Windows sign-in

After setting up and testing BBStreamer, run this from the checkout in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Register-Logon.ps1
```

The task runs under your signed-in account, keeps its window hidden, and can retry after a controller failure. The script registers the task for the next sign-in. To start it immediately, close the foreground controller with Ctrl+C, then run `Start-ScheduledTask -TaskName BBStreamer`. To stop or remove it, use Task Scheduler. For a different dashboard port, pass `-Port` to the registration script and use the same number with `Start.cmd --port`.

## Capture and recovery behavior

- The app monitors Bambu’s local MQTT reports using TLS on port 8883. It subscribes to the printer’s report topic and requests status snapshots. It issues no motion or print controls. A SHA-256 certificate fingerprint is optional in Settings. Without a fingerprint, BBStreamer accepts the printer’s self-signed certificate on the LAN.
- The app captures the whole stock **/live** page. The camera relay and experimental 3D toolpath run in BambuBoard. LAN Liveview and a reachable camera are needed for video. The 3D widget needs WebGL 2 and the exact sliced G-code. If a printer’s firmware keeps a cloud job’s file inaccessible over FTPS, use BambuBoard’s **Load sliced file** option. The H2C uses BambuBoard’s H2D compatibility mapping, including its widget and build-size assumptions. [BambuBoard compatibility and troubleshooting](https://github.com/t0nyz0/BambuBoard/tree/6de94c92c2d1ca14d5bd3210a303829c0b309ecd#supported-printers)
- The default is 720p at 4 Mbps per broadcast, with capture capped at 12 new frames per second and paced output at 30 fps. Audio is silent. Automatic encoder selection probes NVIDIA, Intel, and AMD hardware and falls back to low-thread-count software encoding. The controller and capture processes request Below Normal priority. Chromium and FFmpeg run only during capture or preview. Two printers can stream together. With a one-stream limit, the second starts when a slot opens if it is still printing.
- BBStreamer persists its job and external IDs before proceeding through the broadcast lifecycle. It waits for fresh printer telemetry after a restart, then reconnects the same broadcast if YouTube still has it open. It retries temporary errors and reconciles lost creation responses. A longer printer disconnect releases the encoder while preserving the print. If the next report is idle and the printer never supplied an outcome, BBStreamer records that the print ended without reporting a result. If YouTube has already closed the broadcast, the dashboard shows that state until the next print. Turning off automatic starts leaves assigned broadcasts running until their print ends.
- A broadcast that was scheduled but never went live is removed when the print ends. A live broadcast is completed through YouTube and remains available according to its visibility and YouTube’s recording behavior. YouTube can close a stream after a prolonged interruption. [YouTube broadcast lifecycle](https://developers.google.com/youtube/data/live/life-of-a-broadcast)

## Verification

Run `npm test` to exercise overlapping jobs, completion and cancellation, restart reconciliation, lost responses, OAuth, Discord rate limits, and the capture limit with fixtures.

Windows integration checks used stock BambuBoard 3.3.1 at commit [6de94c9](https://github.com/t0nyz0/BambuBoard/commit/6de94c92c2d1ca14d5bd3210a303829c0b309ecd), a local TLS MQTT fixture, sample camera video and sliced G-code, and a local RTMPS receiver. The physical printers, a real YouTube broadcast, Discord delivery, and load alongside AMP need on-host validation.
