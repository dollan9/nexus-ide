---
source: https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
fetched-at: 2026-10-15T16:06:48Z
fetch-window: 2026-10-15T15:51:00Z/2026-10-15T16:01:00Z
http-status: 200
extraction: curl
note: fetched-at is the moment this file was written from the live response; the actual HTTP round-trips happened inside fetch-window.
---

# Fetch notes (honest record)

The URL above is a **redirect stub**. `curl` returned HTTP 200 with only 99 bytes of
HTML:

```
<!-- redirect file -->
<meta http-equiv="Refresh" content="0; url=reference/api-reference.html" />
```

A first `WebFetch` of the URL returned no extractable content (`---` only), for the same
reason. The text below was therefore obtained by following the stub to its real target:

- resolved URL: https://docs.nvidia.com/nim/large-language-models/latest/reference/api-reference.html
- resolved HTTP status: 200
- extraction: curl + local HTML-to-text pass (57,412 bytes of HTML -> 17,551 characters of text)

Last updated marker printed by the docs page itself: "Last updated on Oct 06, 2026."

# API Reference#

NIM LLM and VLM exposes an OpenAI-compatible inference API backed by
vLLM,
along with NIM-specific management endpoints.

## Inference Endpoints#

These endpoints are provided by the vLLM inference backend.

 |
Endpoint
 |
Description

 |
`POST /v1/chat/completions`
 |
Multi-turn chat completions with message history. Supports streaming and tool calling.

 |
`POST /v1/completions`
 |
Single-turn text completions.

 |
`POST /v1/responses`
 |
Create a model response (OpenAI Responses API).

 |
`GET  /v1/responses/{response_id}`
 |
Retrieve a previously created response.

 |
`POST /v1/responses/{response_id}/cancel`
 |
Cancel a streaming response.

 |
`POST /v1/messages`
 |
Anthropic-compatible messages endpoint.

 |
`POST /v1/messages/count_tokens`
 |
Count tokens for a messages request without running inference.

 |
`GET  /v1/models`
 |
List models currently loaded and available for inference.

 |
`POST /tokenize`
 |
Tokenize input text into token IDs.

 |
`POST /detokenize`
 |
Convert token IDs back to text.

 |
`POST /inference/v1/generate`
 |
Low-level token-in/token-out generation endpoint used by disaggregated prefill/decode deployments. Requires vLLM 0.11.1 or later.

 |
`POST /generative_scoring`
 |
Generative scoring endpoint that returns log-probability-based scores for candidate completions. Requires vLLM 0.20.0 or later.

Render endpoints return the formatted prompt without running inference:

 |
Endpoint
 |
Description

 |
`POST /v1/chat/completions/render`
 |
Render the chat template for a chat completion request.

 |
`POST /v1/completions/render`
 |
Render the prompt template for a completion request.

For full request/response schemas and parameters, refer to the
vLLM OpenAI-Compatible Server documentation
or the interactive OpenAPI explorer at `/docs` on the running container.

For Anthropic-compatible request syntax, refer to the
Anthropic Messages API documentation.

## Management Endpoints#

These endpoints are specific to the NIM container and are served by the
NIM middleware layer or the nginx proxy.

 |
Endpoint
 |
Description

 |
`GET /v1/health/live`
 |
Liveness probe. Returns 200 when the container is running (served by nginx; does not require model to be loaded).

 |
`GET /v1/health/ready`
 |
Readiness probe. Returns 200 when the model is loaded and inference is available.

 |
`GET /v1/metadata`
 |
Deployment metadata including active profile, model info, and license.

 |
`GET /v1/version`
 |
NIM release version and OpenAPI spec version.

 |
`GET /v1/license`
 |
License metadata and full license text.

 |
`GET /v1/manifest`
 |
Model manifest with available profiles and configurations.

 |
`GET /v1/metrics`
 |
Prometheus-compatible metrics (request latency, throughput, queue depth, GPU utilization).

## Examples#

The examples below use `${MODEL_NAME}` as a shell variable. To find
the model ID for your deployment, query the models endpoint:

```
curl -s http://localhost:8000/v1/models
```

Then export it for use in subsequent commands:

```
export MODEL_NAME="meta/llama-3.1-8b-instruct"
```

The model ID matches the value of `NIM_SERVED_MODEL_NAME` when the
variable is set explicitly. If the variable is not set, NIM derives the
name automatically. For more information, refer to
Environment Variables.

### Chat Completions#

To query the Chat Completions API using a text prompt, run the following command:

```
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is GPU computing?\"}],
    \"max_tokens\": 256
  }"
```

To stream the response back to the client, run the following command:

```
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Explain transformers briefly.\"}],
    \"max_tokens\": 256,
    \"stream\": true
  }"
```

To query the Chat Completions API using a text prompt and an
input image, run the following command:

```
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [
      {
        \"role\": \"user\",
        \"content\": [
          {
            \"type\": \"text\",
            \"text\": \"Describe this image in one sentence.\"
          },
          {
            \"type\": \"image_url\",
            \"image_url\": {
              \"url\": \"https://assets.ngc.nvidia.com/products/api-catalog/phi-3-5-vision/example1b.jpg\"
            }
          }
        ]
      }
    ]
  }"
```

### Completions#

To query the Completions API, run the following command:

```
curl -s http://localhost:8000/v1/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"prompt\": \"Once upon a time\",
    \"max_tokens\": 64
  }"
```

### Responses (OpenAI Responses API)#

To query a model using the OpenAI Responses API, run the following command:

```
curl -s http://localhost:8000/v1/responses \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"input\": \"Explain the theory of relativity in one sentence.\"
  }"
```

For Codex CLI setup, required engine arguments, and model naming, refer to
Use Codex CLI with NIM.

### Messages (Anthropic-compatible)#

NIM exposes vLLM’s Anthropic-compatible server at `/v1/messages`. NIM routes
these requests through the nginx proxy and does not rewrite the request or
response body.

To send an Anthropic-compatible message request, run the following command:

```
curl -s http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Hello, how are you?\"}],
    \"max_tokens\": 64
  }"
```

To stream the response back to the client, run the following command:

```
curl -s http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Explain transformers briefly.\"}],
    \"max_tokens\": 256,
    \"stream\": true
  }"
```

Streaming responses use Server-Sent Events (SSE) with Anthropic event types
such as `message_start`, `content_block_start`, `content_block_delta`,
`content_block_stop`, `message_delta`, and `message_stop`.

The Anthropic format uses a top-level `system` field instead of a system
message:

```
curl -s http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"max_tokens\": 256,
    \"system\": \"You are a helpful coding assistant.\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Write a Python hello world.\"}]
  }"
```

To count tokens in a request without running inference, run the following command:

```
curl -s http://localhost:8000/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Hello, how are you?\"}]
  }"
```

NIM does not validate the `x-api-key` header. When you use Anthropic SDK
clients, set the API key to any non-empty string that satisfies the client.

The `/v1/messages` endpoint implements the core Anthropic Messages API format.
Some Anthropic-specific features can depend on the model and vLLM version:

-
Tool use (`tool_use` and `tool_result` content blocks) requires a model with tool-calling support.

-
Extended thinking (`thinking` content blocks) depends on model and vLLM support.

-
The `anthropic-version` header is accepted but not enforced.

-
Batch and admin endpoints are not supported.

For Claude Code setup and model selection, refer to
Use Claude Code with NIM.

#### Anthropic Python SDK#

To use the Anthropic Python SDK with NIM, point the client at the NIM
endpoint and set the API key to any non-empty string:

```
import os
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:8000",
    api_key="not-used",
)

message = client.messages.create(
    model=os.environ["MODEL_NAME"],
    max_tokens=1024,
    messages=[{"role": "user", "content": "What is GPU computing?"}],
)

print(message.content)
```

To stream the response:

```
with client.messages.stream(
    model=os.environ["MODEL_NAME"],
    max_tokens=256,
    messages=[{"role": "user", "content": "Explain CUDA in one paragraph."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

To count tokens without running inference:

```
response = client.messages.count_tokens(
    model=os.environ["MODEL_NAME"],
    messages=[{"role": "user", "content": "Hello, how are you?"}],
)

print(response.input_tokens)
```

### Tokenize and Detokenize#

To tokenize input text into token IDs, run the following command:

```
curl -s http://localhost:8000/tokenize \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"prompt\": \"Hello world\"
  }"
```

Token IDs are model-specific: the same text tokenizes to different IDs across
tokenizers. To make the detokenize example round-trip correctly against the
model you are running, obtain the token IDs from `/tokenize` first, then pass
them to `/detokenize`:

```
TOKENS=$(curl -s http://localhost:8000/tokenize \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${MODEL_NAME}\", \"prompt\": \"Hello world\"}" \
  | jq -c .tokens)

curl -s http://localhost:8000/detokenize \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"tokens\": ${TOKENS}
  }"
```

### List Models#

To list the available models, run the following command:

```
curl -s http://localhost:8000/v1/models
```

### Health Checks#

To perform a liveness or readiness health check, run the following commands:

```
# Liveness (container running)
curl -s http://localhost:8000/v1/health/live

# Readiness (model loaded, ready for inference)
curl -s http://localhost:8000/v1/health/ready
```

### Metadata and Version#

To query the deployment metadata and version, run the following commands:

```
curl -s http://localhost:8000/v1/metadata
curl -s http://localhost:8000/v1/version
```

### Disaggregated Generation#

The `/inference/v1/generate` endpoint exposes vLLM’s low-level
tokens-in/tokens-out generation API. Unlike the OpenAI-compatible
endpoints, it operates on raw token IDs and bypasses chat template
rendering. Use this endpoint for disaggregated prefill/decode deployments
and other advanced use cases that require direct token-level control.
This endpoint is available with vLLM 0.11.1 and later.

To generate from a sequence of input tokens, first tokenize the prompt
and then post the token IDs to `/inference/v1/generate`:

```
TOKENS=$(curl -s http://localhost:8000/tokenize \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${MODEL_NAME}\", \"prompt\": \"Hello\"}" \
  | jq -c .tokens)

curl -s http://localhost:8000/inference/v1/generate \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"token_ids\": ${TOKENS},
    \"sampling_params\": {
      \"max_tokens\": 16,
      \"temperature\": 0.0,
      \"detokenize\": false
    },
    \"stream\": false
  }"
```

The response returns generated token IDs in `choices[].token_ids`. Set
`sampling_params.detokenize` to `true` to have vLLM convert the output
tokens back to text before returning them. For the full request and
response schema for your container, refer to the interactive OpenAPI
explorer at `/docs`.

### Generative Scoring#

The `/generative_scoring` endpoint returns log probability scores for a
fixed set of candidate label tokens. Use generative scoring as an
alternative to the embedding-based pooling endpoints
(`/score`, `/rerank`, `/classify`, `/pooling`). This endpoint is
available with vLLM 0.20.0 and later.

The request requires the following fields:

-
`query`: the query text (or pre-tokenized token IDs).

-
`items`: a list of item texts (or pre-tokenized token IDs) to score against
the query.

-
`label_token_ids`: the token IDs to compute probabilities for. These IDs are
model-specific — obtain them from `/tokenize` for the labels you want to
score against, such as `"yes"` and `"no"`.

Because `label_token_ids` must match the runtime tokenizer, derive them
dynamically rather than hardcoding integers:

```
YES_TOKENS=$(curl -s http://localhost:8000/tokenize \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${MODEL_NAME}\", \"prompt\": \"yes\"}" \
  | jq -r '.tokens[0]')

NO_TOKENS=$(curl -s http://localhost:8000/tokenize \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${MODEL_NAME}\", \"prompt\": \"no\"}" \
  | jq -r '.tokens[0]')

curl -s http://localhost:8000/generative_scoring \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"query\": \"Is the sky blue?\",
    \"items\": [\"\"],
    \"label_token_ids\": [${YES_TOKENS}, ${NO_TOKENS}]
  }"
```

The response returns one score per item in `data[].score`, corresponding to
the probability of the first label token following the query + item prompt.
For the full request and response schema for your container, refer to the
interactive OpenAPI explorer at `/docs`. For a worked end-to-end example,
refer to vLLM’s test suite at
`tests/entrypoints/openai/generative_scoring/test_generative_scoring_e2e.py`.

#### NIM Management Endpoints#

In addition to the OpenAI-compatible inference API provided by the
vLLM backend, NIM exposes the following management endpoints.

##### Health#

###### GET /v1/health/live#

Returns `200 OK` when the container is running.

```
curl -s http://localhost:8000/v1/health/live
```

###### GET /v1/health/ready#

Returns `200 OK` when the model is loaded and ready to
accept inference requests.

```
curl -s http://localhost:8000/v1/health/ready
```

##### Observability#

###### GET /v1/metrics#

Prometheus-compatible
metrics including request latency, throughput, queue depth, and GPU utilization.

```
curl -s http://localhost:8000/v1/metrics
```

See also

Logging and Observability for Prometheus scrape configuration example.

##### Metadata#

###### GET /v1/version#

Returns the NIM release version and OpenAPI specification
version.

```
curl -s http://localhost:8000/v1/version
```

###### GET /v1/metadata#

Returns deployment metadata including the active model
profile ID and name.

```
curl -s http://localhost:8000/v1/metadata
```

###### GET /v1/manifest#

Returns the full model manifest describing available
profiles and their configurations.

```
curl -s http://localhost:8000/v1/manifest
```

###### GET /v1/license#

Returns license information for the running NIM container.

```
curl -s http://localhost:8000/v1/license
```

previous

Environment Variables

next

CLI Reference

 On this page

- Inference Endpoints

- Management Endpoints

- Examples

- Chat Completions

- Completions

- Responses (OpenAI Responses API)

- Messages (Anthropic-compatible)

- Anthropic Python SDK

- Tokenize and Detokenize

- List Models

- Health Checks

- Metadata and Version

- Disaggregated Generation

- Generative Scoring

- NIM Management Endpoints

- Health

- GET /v1/health/live

- GET /v1/health/ready

- Observability

- GET /v1/metrics

- Metadata

- GET /v1/version

- GET /v1/metadata

- GET /v1/manifest

- GET /v1/license

 so the DOM is not blocked -->

 Privacy Policy
 |

 Your Privacy Choices
 |

 Terms of Service
 |

 Accessibility
 |

 Corporate Policies
 |

 Product Security
 |

 Contact

 Copyright © 2024-2026, NVIDIA Corporation.

 Last updated on Oct 06, 2026.
