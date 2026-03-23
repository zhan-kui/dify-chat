# Dify Chat Console

Mobile-first H5 chat console with Dify as the primary backend and OpenAI-compatible provider support.

## Features
- Dify chat with streaming or blocking responses
- Dify file upload flow (upload + attach to chat message)
- OpenAI-compatible providers (OpenAI, Qwen, local gateways)
- Responsive layout for mobile and desktop
- Local-only settings storage

## Quick Start
```bash
npm install
npm run dev
```

## Configuration
### Dify
- Base URL: Dify API base (default `https://api.dify.ai`)
- API Key: Dify app key
- User ID: Stable user identifier for conversation tracking
- Conversation ID: Auto-filled after the first message
- Inputs JSON: Optional `inputs` object for Dify app variables

### OpenAI-Compatible
- Base URL: OpenAI-compatible API endpoint (must include `/v1` or a compatible route)
- API Key: Optional for local deployments
- Model: Model identifier (required)
- System Prompt: Optional system instruction

## Notes
- File upload support depends on server configuration and app settings. If a file type is rejected, try another format.
- Browser requests require CORS enabled on your API endpoint. If CORS blocks requests, use a local reverse proxy.
