# Third-party notices

This project includes a modified copy of [Rohan Muppa’s Brightspace MCP server](https://github.com/RohanMuppa/brightspace-mcp-server), package version 2.0.0, under `upstream/`. Its MIT license and source copyright notices are preserved.

The included source also contains Waterloo-specific session handling, read tools, Odyssey, and outline work from the predecessor deployment. The new gateway, setup commands, deployment files, documentation, and tests are distributed under the same MIT license. This repository starts with a clean source history and contains no predecessor account state.

Node dependencies are recorded in `package-lock.json`. Python transcription dependencies are recorded in `requirements-transcription.lock`. Their own licenses apply. The Docker base image and the downloaded speech model also retain their own licenses.

Piazza integration research used the MIT [hfaran/piazza-api client](https://github.com/hfaran/piazza-api) and read requests observed in Piazza’s own web application. That client is not bundled or installed. The implementation is an unofficial HTTP client and does not imply an official Piazza API agreement.

Names and marks identify compatible services and do not imply endorsement.
