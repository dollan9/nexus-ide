---
source: https://developer.nvidia.com/nim
fetched-at: 2026-10-15T16:06:48Z
fetch-window: 2026-10-15T15:51:00Z/2026-10-15T16:01:00Z
http-status: 200
extraction: webfetch
note: fetched-at is the moment this file was written from the live response; the actual HTTP round-trips happened inside fetch-window.
---

HTTP status 200 confirmed independently with `curl -sL -o /dev/null -w "%{http_code}"`.

## SECONDARY SOURCE (verbatim, needed for the local-NIM sections of NVIDIA_INTEGRATION.md)

The `developer.nvidia.com/nim` landing page is marketing-level and does not contain the
`docker run` command shapes. Those were fetched from the NIM LLM/VLM documentation set,
all HTTP 200 / extraction curl, and are appended below with their own URLs.

- https://docs.nvidia.com/nim/large-language-models/latest/getting-started.html
  -> redirect stub -> https://docs.nvidia.com/nim/large-language-models/latest/get-started/index.html
- https://docs.nvidia.com/nim/large-language-models/latest/get-started/quickstart.html
- https://docs.nvidia.com/nim/large-language-models/latest/get-started/prerequisites.html
- https://docs.nvidia.com/nim/large-language-models/latest/get-started/installation.html
- https://docs.nvidia.com/nim/large-language-models/latest/reference/support-matrix.html
- https://docs.nvidia.com/nim/large-language-models/latest/advanced-use-cases/tool-calling-and-mcp.html

# Quickstart#

This quickstart runs a NIM LLM and VLM container and sends a first inference request. For installation details, refer to installation.

## Prerequisites#

Before you start, complete the following prerequisites:

-
Complete the requirements in prerequisites.

-
Configure `LOCAL_NIM_CACHE` and any credentials required by your image, tag, or model source by following configuration.

-
Pull the container image by following installation.

For eligible public-catalog NIMs, `NGC_API_KEY` and Docker login are optional. Model-source credentials, such as `HF_TOKEN`, can still be required.

## How to Choose the Right Model Profile#

NIM LLM and VLM automatically selects the most optimal model profile based on the detected hardware (for example, number of GPUs or GPU architecture). If you need to manually override this selection, you can specify the `NIM_MODEL_PROFILE` environment variable. For more information, refer to Model Profiles.

## Run NIM#

To run a NIM LLM and VLM container and download the model, complete the following steps according to your NIM type.

Some NIM LLM and VLM containers need extra profile selection or
startup settings beyond the standard path. Refer to
Model Specific Deployment Considerations
to see if the NIM you want to run is listed.

Tip

Mounting a local cache directory lets you avoid re-downloading the model on subsequent restarts. Refer to Local Cache for details.

Note

The exact image tag varies depending on the container type and backend you intend to deploy. Set `${NIM_LLM_IMAGE}` and `${NIM_LLM_MODEL_FREE_IMAGE}` to the vLLM or SGLang image and tag for your model and GPU. Check the Support Matrix for the image and version to use.

Model-Specific NIM

Run the container to download the model.

You can omit the `-e NGC_API_KEY=$NGC_API_KEY` line from `docker run` commands
when the selected image and model artifacts support keyless access.

Note

An NGC API key is only required to download Production Branch (PB) models or
NIMs released prior to NIM LLM and VLM version 2.0.10. PB releases
are indicated by the `-pb<version>` suffix in the model name (for example,
`llama-3.1-8b-instruct-pb6`).

```
export NIM_LLM_IMAGE=nvcr.io/nim/meta/llama-3.1-8b-instruct:2.0.13

docker run --gpus=all \
  -e NGC_API_KEY=$NGC_API_KEY \
  -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" \
  -p 8000:8000 \
  ${NIM_LLM_IMAGE}
```

Model-Free NIM

Run the container with the model-source credentials required by your selected
model. The following example uses a Hugging Face token to authenticate and
download the model.

```
export NIM_LLM_MODEL_FREE_IMAGE=nvcr.io/nim/nvidia/model-free-nim:2.0.13

docker run --gpus=all \
  -e NIM_MODEL_PATH=$NIM_MODEL_PATH \
  -e NIM_SERVED_MODEL_NAME="openai/gpt-oss-20b" \
  -e HF_TOKEN=$HF_TOKEN \
  -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" \
  -p 8000:8000 \
  ${NIM_LLM_MODEL_FREE_IMAGE}
```

Note

If you want to serve a pre-downloaded local model or a private cloud model instead of downloading one from Hugging Face, refer to Model Downloads for your workflow.

## Interact with the API#

There are three main inference endpoints:

-
Chat Completions: `/v1/chat/completions`

-
Text Completions: `/v1/completions`

-
Responses: `/v1/responses`

Tip

All three endpoints support streaming.

The examples on this page use text-only Chat Completions requests. For image,
audio, or video input with supported vision language models, refer
to Image, Audio, and Video Input.

### Find the Model Name#

Replace the `"model"` value in the examples below with the model name served by
your NIM container. To find it, query the models endpoint:

```
curl -s http://localhost:8000/v1/models
```

The `id` field in the response is the model name to use in your requests. For model-specific NIMs, this matches the model identifier (for example, `meta/llama-3.1-8b-instruct`). For
model-free NIMs, the name is set by the `NIM_SERVED_MODEL_NAME` environment variable
(or the name is `ga-model-free-nim` if the environment variable is not set).

Note

You can set the environment variable `NIM_SERVED_MODEL_NAME` to a desired string.
This name is used as the model name in API requests. For more information, refer to
Environment Variables.

### Send a Chat Completion Request#

After the server is running, you can send a request to the chat completion endpoint:

```
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [
      {
        "role": "user",
        "content": "Hello! How are you?"
      }
    ],
    "max_tokens": 100
  }'
```

The expected response:

```
{
  "id":"chatcmpl-9de33afddf166791",
  "object":"chat.completion",
  "created":1782320669,
  "prompt_routed_experts":null,
  "model":"meta/llama-3.1-8b-instruct",
  "choices":[
    {
      "index":0,
      "message":{
        "role":"assistant",
        "content":"I'm just a language model, so I don't have feelings or emotions like humans do. However, I'm functioning properly and ready to assist you with any questions or tasks you may have. How can I help you today?",
        "refusal":null,
        "annotations":null,
        "audio":null,
        "function_call":null,
        "tool_calls":[
          
        ],
        "reasoning":null
      },
      "logprobs":null,
      "finish_reason":"stop",
      "stop_reason":null,
      "token_ids":null,
      "routed_experts":null
    }
  ],
  "service_tier":null,
  "system_fingerprint":"vllm-0.21.0-3c4d71ca",
  "usage":{
    "prompt_tokens":41,
    "total_tokens":88,
    "completion_tokens":47,
    "prompt_tokens_details":null
  },
  "prompt_logprobs":null,
  "prompt_token_ids":null,
  "prompt_text":null,
  "kv_transfer_params":null
}
```

### Verify Health Endpoints#

You can verify that the NIM container is running and ready to accept requests by checking its health endpoints. By default, these endpoints are served on port `8000`. If you set `NIM_HEALTH_PORT`, use that port instead.

#### Live Endpoint#

Perform a liveness check to see if the server is running:

```

----- prerequisites (verbatim extract) -----
# Prerequisites#

Before you deploy a NIM LLM and VLM container, confirm that your environment meets the following requirements.

## Hardware Requirements#

The following table lists the minimum hardware requirements:

 |
Requirement
 |
Specification

 |
CPU
 |
AMD64, ARM64

 |
GPU
 |
Any supported NVIDIA GPU

### Model GPU Memory Requirements#

Different models require different minimum amounts of GPU memory. For example, Llama 3.1 8B Instruct requires a minimum of 24GB of GPU memory.

Confirm that your chosen hardware configuration meets the minimum GPU memory requirement for the model profile you wish to run. For more information, refer to Model Profiles and Support Matrix.

## Software Requirements#

The following table lists the minimum software versions:

 |
Requirement
 |
Specification

 |
Operating System
 |
Ubuntu 22.04 LTS or later recommended

 |
Container Toolkit
 |
1.14.0 or later

 |
CUDA SDK
 |
12.9 or later

 |
GPU Driver
 |
580 or later

 |
Docker
 |
24.0 or later

### Operating System#

While other Linux distributions can be compatible with NIM LLM and VLM, they have not been officially validated.

Use Ubuntu 22.04 LTS or later for the best experience.

### CUDA SDK#

Install CUDA SDK by following the CUDA installation guide for Linux.

### GPU Drivers#

Install the NVIDIA GPU drivers by following the NVIDIA Driver Installation Guide.

### Docker#

Docker is required to run the containerized NIM services.

-
Install Docker Engine for your Linux distribution by following the Docker Engine installation guide.

-
Verify that the Docker daemon is running and that your user can execute `docker` commands without `sudo`. Add your user to the `docker` group if needed:

```
sudo groupadd docker
sudo usermod -aG docker $USER
```

-
Log out and log back in so the group change takes effect.

### Container Toolkit#

The NVIDIA Container Toolkit enables Docker containers to access the host GPU.

-
Install the toolkit by following the NVIDIA Container Toolkit installation guide.

-
Configure Docker to use the NVIDIA runtime by following the Docker configuration steps.

-
Restart the Docker daemon after configuration:

```
sudo systemctl restart docker
```

## NIM Container Access#

To download and deploy NIM containers, you need one of the following:

-
A free NVIDIA Developer Program membership.

-
An NVIDIA AI Enterprise license. To request a free 90-day evaluation license, refer to Ways to Get Started With NVIDIA AI Enterprise and Activate Your NVIDIA AI Enterprise License.

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

To confirm that your setup is correct, run the following command:

```
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

This command should produce output similar to one of the following, where you can confirm CUDA driver version, and available GPUs.

```
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 580.95.05              Driver Version: 580.95.05      CUDA Version: 12.9     |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================|
|   0  NVIDIA H100 80GB HBM3          On  |   00000000:1B:00.0 Off |                    0 |
| N/A   36C    P0            112W /  700W |   78489MiB /  81559MiB |      0%      Default |
|                                         |                        |             Disabled |
+-----------------------------------------+------------------------+----------------------+

+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI        PID   Type   Process name                              GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|  No running processes found                                                             |
+-----------------------------------------------------------------------------------------+
```

previous

About Getting Started with NIM LLM and VLM

next

Configuration

 On this page

- Hardware Requirements

- Model GPU Memory Requirements

- Software Requirements

- Operating System

- CUDA SDK

- GPU Drivers

- Docker

- Container Toolkit

- NIM Container Access

- Generate Access Credentials

- Verify NVIDIA Runtime Access

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

----- tool-calling-and-mcp (verbatim extract) -----
# Tool Calling and MCP Integration#

NIM LLM and VLM supports OpenAI-compatible tool calling through vLLM’s tool calling engine. Tool calling lets models invoke external functions by returning structured tool calls instead of text responses, enabling integration with Model Context Protocol (MCP) servers and any client library that uses the OpenAI tools format.

## Prerequisites#

Before you start, complete the following prerequisites:

-
Deploy a chat-capable NIM LLM and VLM container. For deployment instructions, refer to the Quickstart.

-
Identify the built-in `--tool-call-parser` name that matches your model, or plan to supply a custom plugin. For the built-in parser list and plugin path rules, refer to Custom Parsers and Chat Templates.

## Enable Tool Calling#

Tool calling requires two vLLM engine arguments: `--enable-auto-tool-choice` and a `--tool-call-parser` that matches your model.

To enable tool calling, complete the following steps:

-
Pass both arguments as CLI arguments to `nim-serve`.

```
docker run --gpus all \
  -e NIM_MODEL_PATH=hf://meta-llama/Llama-3.1-8B-Instruct \
  -p 8000:8000 \
  ${NIM_LLM_MODEL_FREE_IMAGE}:2.0.13 \
  nim-serve --enable-auto-tool-choice --tool-call-parser llama3_json
```

-
Optional: For a Kubernetes workload, pass the same arguments through the container
`args` field.

```
containers:
  - name: nim
    image: <nim_llm_image>
    args:
      - "--enable-auto-tool-choice"
      - "--tool-call-parser"
      - "llama3_json"
```

The following table describes the tool-calling arguments:

 |
Argument
 |
Description

 |
`--enable-auto-tool-choice`
 |
Allows the model to choose between generating text or calling a tool. Required for tool calling.

 |
`--tool-call-parser <parser>`
 |
Built-in parser name for extracting tool calls from model output. Must match the model’s tool calling format (for example, `llama3_json` for Llama 3.1 and 3.3).

 |
`--tool-parser-plugin <path>`
 |
Path to a custom tool-call parser file. Accepts an absolute path or a path relative to the model checkpoint directory (the path is used as-is, with no basename stripping). Required only when no built-in parser fits your model.

Both `--enable-auto-tool-choice` and `--tool-call-parser` are required together. For the full list of built-in parsers, the supported models, and how to provide a custom plugin file, refer to Custom Parsers and Chat Templates. For request and response format and schema details, refer to the vLLM tool calling documentation. For more information on container arguments, the `NIM_PASSTHROUGH_ARGS` fallback, and configuration precedence, refer to Advanced Configuration.

-
After you enable tool calling, send tool definitions on the `/v1/chat/completions` endpoint with the `tools` parameter and receive tool calls.

For request and response format, examples, and the tool result loop, refer to the vLLM tool calling documentation.

## Use MCP Tools with NIM#

NIM LLM and VLM does not connect to MCP servers directly. Your client application connects to MCP servers, converts tool definitions to the OpenAI tools format, and sends them in the `tools` array of a Chat Completions request.

To use MCP tools with NIM, complete the following steps:

-
Connect your client application to the MCP servers that expose the tools you need.

-
Convert those MCP tool definitions to the OpenAI tools format.

-
Send the converted definitions in the `tools` array of a Chat Completions request.

-
