"""NEXUS-IDE ai-service — öron (röst), ögon (vision), OCR, embeddings och RAG.

Paketinnehållet är medvetet tunt: all affärslogik ligger i `app.*`-modulerna så att
pytest kan importera och testa dem utan att starta en server.
"""

from __future__ import annotations

__version__ = "1.0.0"
