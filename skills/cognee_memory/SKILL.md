# Cognee Memory - Knowledge Graph Integration

This skill provides dual-brain memory integration using Cognee's knowledge graph alongside LanceDB vector storage.

## Features

- **Dual Write**: Memories are saved to both LanceDB (vector) and Cognee (graph)
- **Dual Read**: Searches query both systems and merge results
- **Graph Relationships**: Cognee builds entity relationships automatically
- **Semantic Search**: Vector similarity + graph traversal

## Prerequisites

```bash
pip install cognee
```

## Usage

The skill is automatically integrated into the `save_memory` and `memory_search` tools. No manual invocation needed.

## How It Works

### Save Memory
1. Content saved to LanceDB (vector embedding)
2. Content synced to Cognee (knowledge graph)
3. Cognee extracts entities and relationships

### Search Memory
1. Query searches LanceDB (vector similarity)
2. Query searches Cognee (graph traversal)
3. Results merged with Cognee results prioritized

## Configuration

No configuration needed. The skill uses the Python script at:
`skills/cognee_memory/scripts/cognee_memory.py`

## Status Messages

- Success: "Memory saved successfully (and synced to Cognee Graph)."
- Failure: "Memory saved successfully (Cognee sync failed: <reason>)."
