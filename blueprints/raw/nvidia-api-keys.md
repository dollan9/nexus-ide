---
source: https://build.nvidia.com/settings/api-keys
fetched-at: 2026-10-15T16:06:48Z
fetch-window: 2026-10-15T15:51:00Z/2026-10-15T16:01:00Z
http-status: 200 (curl) / 404 (WebFetch)
extraction: webfetch
note: fetched-at is the moment this file was written from the live response; the actual HTTP round-trips happened inside fetch-window.
---

## What actually happened — recorded, not invented

This page is behind an authentication gate, and the two fetch methods disagreed:

- `WebFetch` -> **HTTP 404 Not Found**. It returned no content and advised not retrying.
- `curl -sL` -> **HTTP 200**, 75,879 bytes, but the body is a client-rendered SPA shell.
  Server-side HTML-to-text extraction yields only 508 characters, i.e. the sign-in wall.

Retried 3 times with backoff. Every attempt returned the same sign-in shell. **No
authenticated key-management UI was reachable**, because no NVIDIA session exists on this
machine and no API key was used (that is the point of FAS 1: the user creates their own).

### Verbatim text the page did return (the sign-in gate)

## Sign In to Get Started with NVIDIA AI

- Free serverless APIs for development
 Accelerated by DGX Cloud

- Self-Host on your GPU infrastructure
- Continuous vulnerability fixes

Next
Next
By proceeding, I agree to join the NVIDIA Developer Program and accept the NVIDIA Technology Access Terms of Use

Explore

Models

Skills

Blueprints

Playbooks

GPUs

Docs

Terms of Use

Privacy Policy


## SECONDARY SOURCE (verbatim): the documented way to create a key

The authoritative, un-authenticated instructions for creating the key live in the NIM
LLM/VLM documentation, not in the gated SPA:

- source: https://docs.nvidia.com/nim/large-language-models/latest/get-started/prerequisites.html
- fetched-at: same timestamp as this file
- http-status: 200
- extraction: curl

## Generate Access Credentials#

Create the credentials required by your container type and model source. Use the following tabs to choose the matching workflow.

Model-Specific NIM

NGC Personal API Key

An NGC Personal API key is not required to access most NVIDIA NIM containers and
models hosted on NGC. An NGC API key is only required to download Production
Branch (PB) models or NIMs released prior to NIM LLM and VLM version
2.0.10. This Get Started documentation uses a current feature branch model as an
example, so creating an NGC Personal API key is optional.

If you want to create an NGC Personal API key, do the following:

-
Generate the Personal API Key on the Setup API Keys page.

-
When creating the Personal API key, select at least NGC Catalog from the
Services Included list. You can also include additional services if you want
to use the same key for other purposes.

Warning

Legacy API keys are not supported by NIM LLM and VLM. Always use a
Personal API Key.

Model-Free NIM

Hugging Face Access Token

The required credentials depend on your model source.

The public model-free NIM container can be pulled from NGC without an NGC API
key when you use an eligible public-catalog image and tag. An NGC API key is
only needed for PB NIMs, NIMs released prior to NIM LLM and VLM
version 2.0.10, private or gated NIM container images, or NGC model artifacts
that require credentials.

To download models from Hugging Face, create a
Hugging Face access token
with read permissions (or higher, only if your org or private repos require
it). This token allows model-free NIM to fetch models directly from Hugging
Face.

Note

If you want to serve a pre-downloaded local model or a private cloud model instead of downloading one from Hugging Face, you do not need a Hugging Face access token. Refer to Model Downloads for your workflow.

## Verify NVIDIA Runtime Access#
