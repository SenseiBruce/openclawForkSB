#!/usr/bin/env python3
"""Cognee Memory Integration Script"""
import sys
import json

def add_memory(content: str) -> None:
    """Add content to Cognee knowledge graph"""
    try:
        import cognee
        cognee.add(content)
        cognee.cognify()
        print(f"Added to Cognee: {content[:50]}...")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

def query_memory(query: str) -> None:
    """Query Cognee knowledge graph"""
    try:
        import cognee
        results = cognee.search("INSIGHTS", query)
        if results:
            output = []
            for result in results[:3]:
                if hasattr(result, 'text'):
                    output.append(result.text)
                elif isinstance(result, dict) and 'text' in result:
                    output.append(result['text'])
                elif isinstance(result, str):
                    output.append(result)
            if output:
                print("\n".join(output))
            else:
                print("No results found")
        else:
            print("No results found")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: cognee_memory.py <add|query> <content>", file=sys.stderr)
        sys.exit(1)
    
    command = sys.argv[1]
    content = sys.argv[2]
    
    if command == "add":
        add_memory(content)
    elif command == "query":
        query_memory(content)
    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)
