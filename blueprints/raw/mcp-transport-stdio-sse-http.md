---
source: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
fetched-at: 2026-10-15T16:06:48Z
fetch-window: 2026-10-15T15:51:00Z/2026-10-15T16:01:00Z
http-status: 200
extraction: curl
note: fetched-at is the moment this file was written from the live response; the actual HTTP round-trips happened inside fetch-window.
---

Requested additionally by the spec ("also save the transport page if you can reach it:
stdio + SSE + streamable HTTP"). It was reachable: HTTP 200, 12,213 characters of text
after HTML-to-text extraction. `WebFetch` of the same URL also succeeded and agreed with
this content.

Note on "SSE": standalone SSE is no longer a current transport. In protocol version
2025-06-18 the SSE mechanism exists only *inside* the Streamable HTTP transport, and the
older HTTP+SSE transport (2024-11-05) is deprecated with an explicit backward-compatibility
procedure. Both are covered verbatim below.

# Transports

 Copy pageCopy page

 Copy pageCopy page

MCP uses JSON-RPC to encode messages. JSON-RPC messages MUST be UTF-8 encoded.
The protocol currently defines two standard transport mechanisms for client-server
communication:

- stdio, communication over standard in and standard out

- Streamable HTTP

Clients SHOULD support stdio whenever possible.
It is also possible for clients and servers to implement
custom transports in a pluggable fashion.

## ​ stdio

In the stdio transport:

- The client launches the MCP server as a subprocess.

- The server reads JSON-RPC messages from its standard input (`stdin`) and sends messages
to its standard output (`stdout`).

- Messages are individual JSON-RPC requests, notifications, or responses.

- Messages are delimited by newlines, and MUST NOT contain embedded newlines.

- The server MAY write UTF-8 strings to its standard error (`stderr`) for logging
purposes. Clients MAY capture, forward, or ignore this logging.

- The server MUST NOT write anything to its `stdout` that is not a valid MCP message.

- The client MUST NOT write anything to the server’s `stdin` that is not a valid MCP
message.

## ​ Streamable HTTP

This replaces the HTTP+SSE
transport from
protocol version 2024-11-05. See the backwards compatibility
guide below.
In the Streamable HTTP transport, the server operates as an independent process that
can handle multiple client connections. This transport uses HTTP POST and GET requests.
Server can optionally make use of
Server-Sent Events (SSE) to stream
multiple server messages. This permits basic MCP servers, as well as more feature-rich
servers supporting streaming and server-to-client notifications and requests.
The server MUST provide a single HTTP endpoint path (hereafter referred to as the
MCP endpoint) that supports both POST and GET methods. For example, this could be a
URL like `https://example.com/mcp`.

#### ​ Security Warning

When implementing Streamable HTTP transport:

- Servers MUST validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks

- When running locally, servers SHOULD bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)

- Servers SHOULD implement proper authentication for all connections

Without these protections, attackers could use DNS rebinding to interact with local MCP servers from remote websites.

### ​ Sending Messages to the Server

Every JSON-RPC message sent from the client MUST be a new HTTP POST request to the
MCP endpoint.

- The client MUST use HTTP POST to send JSON-RPC messages to the MCP endpoint.

- The client MUST include an `Accept` header, listing both `application/json` and
`text/event-stream` as supported content types.

- The body of the POST request MUST be a single JSON-RPC request, notification, or response.

- If the input is a JSON-RPC response or notification:

- If the server accepts the input, the server MUST return HTTP status code 202
Accepted with no body.

- If the server cannot accept the input, it MUST return an HTTP error status code
(e.g., 400 Bad Request). The HTTP response body MAY comprise a JSON-RPC error
response that has no `id`.

- If the input is a JSON-RPC request, the server MUST either
return `Content-Type: text/event-stream`, to initiate an SSE stream, or
`Content-Type: application/json`, to return one JSON object. The client MUST
support both these cases.

- If the server initiates an SSE stream:

- The SSE stream SHOULD eventually include JSON-RPC response for the
JSON-RPC request sent in the POST body.

- The server MAY send JSON-RPC requests and notifications before sending the
JSON-RPC response. These messages SHOULD relate to the originating client
request.

- The server SHOULD NOT close the SSE stream before sending the JSON-RPC response
for the received JSON-RPC request, unless the session
expires.

- After the JSON-RPC response has been sent, the server SHOULD close the SSE
stream.

- Disconnection MAY occur at any time (e.g., due to network conditions).
Therefore:

- Disconnection SHOULD NOT be interpreted as the client cancelling its request.

- To cancel, the client SHOULD explicitly send an MCP `CancelledNotification`.

- To avoid message loss due to disconnection, the server MAY make the stream
resumable.

### ​ Listening for Messages from the Server

- The client MAY issue an HTTP GET to the MCP endpoint. This can be used to open an
SSE stream, allowing the server to communicate to the client, without the client first
sending data via HTTP POST.

- The client MUST include an `Accept` header, listing `text/event-stream` as a
supported content type.

- The server MUST either return `Content-Type: text/event-stream` in response to
this HTTP GET, or else return HTTP 405 Method Not Allowed, indicating that the server
does not offer an SSE stream at this endpoint.

- If the server initiates an SSE stream:

- The server MAY send JSON-RPC requests and notifications on the stream.

- These messages SHOULD be unrelated to any concurrently-running JSON-RPC
request from the client.

- The server MUST NOT send a JSON-RPC response on the stream unless
resuming a stream associated with a previous client
request.

- The server MAY close the SSE stream at any time.

- The client MAY close the SSE stream at any time.

### ​ Multiple Connections

- The client MAY remain connected to multiple SSE streams simultaneously.

- The server MUST send each of its JSON-RPC messages on only one of the connected
streams; that is, it MUST NOT broadcast the same message across multiple streams.

- The risk of message loss MAY be mitigated by making the stream
resumable.

### ​ Resumability and Redelivery

To support resuming broken connections, and redelivering messages that might otherwise be
lost:

- Servers MAY attach an `id` field to their SSE events, as described in the
SSE standard.

- If present, the ID MUST be globally unique across all streams within that
session—or all streams with that specific client, if session
management is not in use.

- If the client wishes to resume after a broken connection, it SHOULD issue an HTTP
GET to the MCP endpoint, and include the
`Last-Event-ID`
header to indicate the last event ID it received.

- The server MAY use this header to replay messages that would have been sent
after the last event ID, on the stream that was disconnected, and to resume the
stream from that point.

- The server MUST NOT replay messages that would have been delivered on a
different stream.

In other words, these event IDs should be assigned by servers on a per-stream basis, to
act as a cursor within that particular stream.

### ​ Session Management

An MCP “session” consists of logically related interactions between a client and a
server, beginning with the initialization phase. To support
servers which want to establish stateful sessions:

- A server using the Streamable HTTP transport MAY assign a session ID at
initialization time, by including it in an `Mcp-Session-Id` header on the HTTP
response containing the `InitializeResult`.

- The session ID SHOULD be globally unique and cryptographically secure (e.g., a
securely generated UUID, a JWT, or a cryptographic hash).

- The session ID MUST only contain visible ASCII characters (ranging from 0x21 to
0x7E).

- If an `Mcp-Session-Id` is returned by the server during initialization, clients using
the Streamable HTTP transport MUST include it in the `Mcp-Session-Id` header on
all of their subsequent HTTP requests.

- Servers that require a session ID SHOULD respond to requests without an
`Mcp-Session-Id` header (other than initialization) with HTTP 400 Bad Request.

- The server MAY terminate the session at any time, after which it MUST respond
to requests containing that session ID with HTTP 404 Not Found.

- When a client receives HTTP 404 in response to a request containing an
`Mcp-Session-Id`, it MUST start a new session by sending a new `InitializeRequest`
without a session ID attached.

- Clients that no longer need a particular session (e.g., because the user is leaving
the client application) SHOULD send an HTTP DELETE to the MCP endpoint with the
`Mcp-Session-Id` header, to explicitly terminate the session.

- The server MAY respond to this request with HTTP 405 Method Not Allowed,
indicating that the server does not allow clients to terminate sessions.

### ​ Sequence Diagram

### ​ Protocol Version Header

If using HTTP, the client MUST include the `MCP-Protocol-Version: <protocol-version>` HTTP header on all subsequent requests to the MCP
server, allowing the MCP server to respond based on the MCP protocol version.
For example: `MCP-Protocol-Version: 2025-06-18`
The protocol version sent by the client SHOULD be the one negotiated during
initialization.
For backwards compatibility, if the server does not receive an `MCP-Protocol-Version`
header, and has no other way to identify the version - for example, by relying on the
protocol version negotiated during initialization - the server SHOULD assume protocol
version `2025-03-26`.
If the server receives a request with an invalid or unsupported
`MCP-Protocol-Version`, it MUST respond with `400 Bad Request`.

### ​ Backwards Compatibility

Clients and servers can maintain backwards compatibility with the deprecated HTTP+SSE
transport (from
protocol version 2024-11-05) as follows:
Servers wanting to support older clients should:

- Continue to host both the SSE and POST endpoints of the old transport, alongside the
new “MCP endpoint” defined for the Streamable HTTP transport.

- It is also possible to combine the old POST endpoint and the new MCP endpoint, but
this may introduce unneeded complexity.

Clients wanting to support older servers should:

- Accept an MCP server URL from the user, which may point to either a server using the
old transport or the new transport.

- Attempt to POST an `InitializeRequest` to the server URL, with an `Accept` header as
defined above:

- If it succeeds, the client can assume this is a server supporting the new Streamable
HTTP transport.

- If it fails with an HTTP 4xx status code (e.g., 405 Method Not Allowed or 404 Not
Found):

- Issue a GET request to the server URL, expecting that this will open an SSE stream
and return an `endpoint` event as the first event.

- When the `endpoint` event arrives, the client can assume this is a server running
the old HTTP+SSE transport, and should use that transport for all subsequent
communication.

## ​ Custom Transports

Clients and servers MAY implement additional custom transport mechanisms to suit
their specific needs. The protocol is transport-agnostic and can be implemented over any
communication channel that supports bidirectional message exchange.
Implementers who choose to support custom transports MUST ensure they preserve the
JSON-RPC message format and lifecycle requirements defined by MCP. Custom transports
SHOULD document their specific connection establishment and message exchange patterns
to aid interoperability.

Was this page helpful?

 Yes No

Lifecycle
Authorization

github discord

 Assistant

Responses are generated using AI and may contain mistakes.

===== SECONDARY SOURCE: the newer 2026-07-28 transports binding page =====
---
source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
fetched-at: 2026-10-15T16:05:27Z
http-status: 200
extraction: curl
---

# Overview

 Copy pageCopy page

 Copy pageCopy page

This page defines what a transport must provide to carry MCP messages, the
standard transport bindings, and the requirements for defining new ones.
Protocol semantics are identical on every transport. A transport is a
binding: it defines how messages are framed and delivered, how request
metadata is carried, and how cancellation and termination are signaled. It
does not define what the messages mean: the
message patterns are part of the core
protocol and are the same on every binding. The binding pages specify the
standard transports:

- stdio: newline-delimited
messages over the standard streams of a client-launched subprocess.

- Streamable HTTP:
each message is an HTTP POST to a single MCP endpoint; replies arrive as
a JSON object or a request-scoped SSE stream.

It is also possible for clients and servers to implement
custom transports.

## ​ Messages

MCP uses JSON-RPC to encode messages. JSON-RPC messages MUST be UTF-8
encoded.
A binding MUST deliver client-sent requests and notifications to the
server, and server-sent responses and notifications to the client. No
other message direction exists: per the
message patterns, servers do not
initiate JSON-RPC requests and clients do not send JSON-RPC responses.

## ​ Request Metadata

All protocol metadata travels in the message body: every request carries its
protocol version and client capabilities in
`_meta.io.modelcontextprotocol/*`
fields.
A binding MAY additionally mirror selected body fields into envelope
metadata. The Streamable HTTP transport mirrors them into
HTTP headers
so that intermediaries can route and inspect requests without parsing the
body. The body remains the source of truth; bindings that mirror metadata
define how mismatches are rejected.

## ​ Cancellation

Each binding defines how a client abandons an in-flight request: on stdio
the client sends a `notifications/cancelled` notification; on Streamable
HTTP it closes the request’s response stream. The protocol-level rules are
the same everywhere; see
Cancellation.

## ​ Custom Transports

Clients and servers MAY implement additional custom transport mechanisms
to suit their specific needs. The protocol is transport-agnostic and can be
implemented over any communication channel that supports bidirectional
message exchange.
Implementers who choose to support custom transports MUST preserve the
JSON-RPC message format, the
message patterns, and the per-request
metadata model. Custom transports SHOULD document their connection
establishment, message framing, and cancellation patterns to aid
interoperability.
Custom transports that run over a reliable bidirectional byte stream (e.g.,
Unix domain sockets or TCP) SHOULD reuse the
stdio framing rather than
defining a new one: the stdio binding is just newline-delimited JSON-RPC
over a byte stream, and only its process-lifecycle rules are specific to
standard streams.

## ​ Backward Compatibility

Earlier protocol revisions established a connection-scoped session with an
`initialize` handshake and allowed servers to initiate JSON-RPC requests.
Clients and servers that interoperate with those revisions detect the
counterpart’s era and fall back as described in
Versioning: Backward Compatibility,
which includes a compatibility matrix for implementors. Each binding page
describes its transport-specific detection mechanics.

Was this page helpful?

 Yes No

Progress
stdio

github discord

 Assistant

Responses are generated using AI and may contain mistakes.
