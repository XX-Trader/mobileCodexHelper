# Architecture

[中文](ARCHITECTURE.zh-CN.md) | [English](ARCHITECTURE.md)

This document is not for the fastest possible deployment path.  
If you already have the stack running and want to understand *why* this setup is recommended, this is the right place.

## One-line summary

The core idea is:

do not expose Codex directly to the public internet,  
run it locally on your own PC, and provide a small, private web control surface so the phone is used mainly for viewing and chat-based control.

## Why not expose the app directly

Because this project ultimately controls local Codex sessions on your PC, which is usually a high-trust environment.

If the exposure model is too loose, risks go up quickly:

- credential stuffing can reach the login page directly
- internet scans can discover the service
- too many high-risk endpoints may remain reachable
- a stolen password could let an unknown device log in immediately

So the goal is not “least effort at any cost”.  
The goal is “personal use with a safer and more controlled deployment model”.

## Recommended structure

Recommended runtime shape:

```text
Phone browser
   ↓
Tailscale private HTTPS
   ↓
Local nginx
   ↓
Local claudecodeui with this project's patches
   ↓
Local Codex sessions
```

## What each layer does

### 1. Phone browser

The phone is mainly for:

- viewing projects
- viewing sessions
- sending follow-up prompts

It is not intended to be a full admin console or a remote desktop replacement.

### 2. Tailscale private network

This limits access to your own device network first.

Benefits:

- far less public exposure
- easier phone-to-PC access
- a good fit for long-term personal use

### 3. nginx

This is the proxy layer in front of the app. It is responsible for:

- providing a single entrypoint
- forwarding traffic to the local app
- adding security headers
- rate limiting login attempts
- letting the Node app remain on localhost

### 4. claudecodeui plus this project's patches

This layer provides:

- the web UI
- project, session, and message APIs
- mobile-friendly interaction behavior
- hardened-mode restrictions
- trusted-device and first-approval logic

### 5. Local Codex sessions

This is where the real work happens.  
The phone is not running Codex directly. It is controlling the Codex sessions and projects that already exist on the PC.

## Why first-time device approval matters

This is one of the most valuable security boundaries in the whole project.

Without it:

- anyone with the account password might log in from an unknown device immediately

With it:

- a new device must wait for desktop approval
- the PC owner can inspect device name, platform, user agent, and IP
- only approved devices enter the trusted-device whitelist

For a personal remote control panel, this matters a lot.

## Why there is both cookie auth and fallback transport

Different phone environments behave differently.

### In normal browsers

The best path is usually:

- same-origin cookie session

### In WebView or wrapper apps

Some wrappers behave poorly around:

- cookies
- WebSocket
- request headers
- local storage

So the project keeps compatibility fallbacks:

- device-bound bearer fallback for HTTP
- token fallback for WebSocket handshake

The important point is:

- those fallbacks exist for compatibility, not to weaken the trust model
- new devices still require approval before they become trusted

## Why unread red badges moved to the server

The green and red sidebar indicators look related, but they represent different kinds of state:

- green means a session is still processing, so it remains a realtime backend-driven status
- red means a session finished and has not been viewed yet, so it is a durable result state that should sync across devices

To make "phone and desktop stay in sync when either side opens the finished session" work reliably, unread red badges now live on the server:

- the unread-completed state is stored in `session_notifications`
- the backend writes unread state when a session finishes
- any device can clear it through `/api/session-notifications/read`
- the server then broadcasts `session-notifications-state` over WebSocket so every connected client updates together

This keeps the split intentional:

- red unread state is cross-device and durable
- green processing state stays lightweight and realtime
- no extra device heartbeat system is required just to keep unread badges consistent

## Why project hiding lives in server-side config

On mobile, too many projects create noise. The real requirement is usually "hide it for now without deleting anything".

That is why project visibility is not stored as a frontend-only preference. It is written back to `~/.claude/project-config.json` instead:

- hidden projects are marked with `hidden: true`
- the main project list filters them out
- the "hidden projects" dialog reads and restores them through backend APIs
- in fixed allowlist mode, hidden projects also disappear from the folder-picker suggestions

Benefits:

- hidden state survives page refreshes
- phone and desktop stay aligned on the same project visibility
- no project files or conversation history are deleted by accident

## Why language preference also moved server-side

If language only lives in browser `localStorage`, then:

- `127.0.0.1` and the Tailscale hostname each keep a separate value
- desktop and mobile browsers can show different languages for the same account
- every new device has to be switched manually again

Language preference is now stored at the user level:

- the default language is Simplified Chinese
- after login, the frontend syncs from the server-side preference
- older devices that only had a local language saved can migrate it once when the server has not been explicitly set yet
- the same account now sees one consistent language across desktop and mobile

## Why hardened mode stays enabled by default

Because the goal is remote phone control, not full remote exposure of every capability.

A more restricted default is better for both personal use and open-source publishing:

- smaller attack surface
- less chance of accidentally exposing dangerous features
- easier to explain to new users what the project is actually for

## Recommended usage model

The intended model is:

- one owner
- the PC is the execution machine
- the phone is the remote viewing and chat-control device
- access happens through a private network
- new devices are approved from the desktop tool

## What is not recommended

This default architecture is not a great fit for:

- multi-user sharing
- direct public exposure
- turning it into a general remote execution service
- re-enabling broader high-risk interfaces without a fresh audit

## The four things worth remembering

If you skip everything else, remember these four points:

1. keep the app local, do not expose it directly  
2. let the phone connect through a private entrypoint  
3. require desktop approval for a new device  
4. keep the phone focused on viewing and chat control, not broad high-risk power
