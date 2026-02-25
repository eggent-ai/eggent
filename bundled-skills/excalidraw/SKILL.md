---
name: excalidraw
description: Create and edit Excalidraw diagrams programmatically. Use when the user asks to create diagrams, flowcharts, architecture diagrams, wireframes, or any visual drawings in Excalidraw format (.excalidraw files).
---

# Excalidraw Diagram Creation

This skill enables you to create beautiful, hand-drawn style diagrams in the Excalidraw JSON format.

## File Format Overview

Excalidraw files (`.excalidraw`) are JSON with this structure:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": null
  },
  "files": {}
}
```

## Quick Start - Creating Elements

Every element needs at minimum: `type`, `id`, `x`, `y`, and styling properties.

### Minimal Rectangle
```json
{
  "type": "rectangle",
  "id": "rect-1",
  "x": 100,
  "y": 100,
  "width": 200,
  "height": 100,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "seed": 1234,
  "version": 1,
  "versionNonce": 1234,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false,
  "roundness": { "type": 3 }
}
```

### Text Element
```json
{
  "type": "text",
  "id": "text-1",
  "x": 120,
  "y": 130,
  "width": 160,
  "height": 25,
  "text": "Hello World",
  "fontSize": 20,
  "fontFamily": 1,
  "textAlign": "center",
  "verticalAlign": "middle",
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "seed": 5678,
  "version": 1,
  "versionNonce": 5678,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false,
  "containerId": null,
  "originalText": "Hello World",
  "autoResize": true,
  "lineHeight": 1.25
}
```

### Arrow Element
```json
{
  "type": "arrow",
  "id": "arrow-1",
  "x": 300,
  "y": 150,
  "width": 100,
  "height": 0,
  "points": [[0, 0], [100, 0]],
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "startBinding": null,
  "endBinding": null,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "seed": 9012,
  "version": 1,
  "versionNonce": 9012,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false
}
```

## Element Types

| Type | Use For |
|------|---------|
| `rectangle` | Boxes, containers, cards |
| `ellipse` | Circles, ovals, nodes |
| `diamond` | Decision points, conditions |
| `text` | Labels, descriptions |
| `arrow` | Connections, flow direction |
| `line` | Connectors without arrowheads |
| `freedraw` | Hand-drawn paths |
| `image` | Embedded images |
| `frame` | Grouping/framing elements |

## Color Palette (Recommended)

### Backgrounds
- `#a5d8ff` - Light blue
- `#b2f2bb` - Light green
- `#ffec99` - Light yellow
- `#ffc9c9` - Light red/pink
- `#e9ecef` - Light gray
- `#d0bfff` - Light purple
- `#99e9f2` - Light cyan

### Strokes
- `#1e1e1e` - Default black
- `#1971c2` - Blue
- `#2f9e44` - Green
- `#f08c00` - Orange
- `#e03131` - Red
- `#9c36b5` - Purple

## Styling Properties

| Property | Values | Description |
|----------|--------|-------------|
| `fillStyle` | `"solid"`, `"hachure"`, `"cross-hatch"` | Fill pattern |
| `strokeWidth` | `1`, `2`, `4` | Line thickness |
| `strokeStyle` | `"solid"`, `"dashed"`, `"dotted"` | Line style |
| `roughness` | `0`, `1`, `2` | Hand-drawn feel (0=smooth, 2=rough) |
| `opacity` | `0-100` | Transparency |
| `roundness` | `{ "type": 3 }` | Rounded corners |

## Connecting Elements with Arrows

To connect shapes with arrows, use bindings:

```json
{
  "type": "arrow",
  "id": "arrow-1",
  "startBinding": {
    "elementId": "rect-1",
    "focus": 0,
    "gap": 5
  },
  "endBinding": {
    "elementId": "rect-2",
    "focus": 0,
    "gap": 5
  },
  "points": [[0, 0], [200, 0]]
}
```

Also add `boundElements` to the connected shapes:
```json
{
  "type": "rectangle",
  "id": "rect-1",
  "boundElements": [{ "id": "arrow-1", "type": "arrow" }]
}
```

## Font Families

| Value | Font |
|-------|------|
| `1` | Hand-drawn (Virgil) |
| `2` | Normal (Helvetica) |
| `3` | Code (Cascadia) |

## Best Practices

1. **Generate unique IDs** - Use descriptive prefixes like `rect-1`, `arrow-2`, `text-header`
2. **Use random seeds** - Each element needs a unique `seed` for consistent rendering
3. **Space elements well** - Leave 50-100px between elements
4. **Align elements** - Use consistent x/y coordinates for visual alignment
5. **Group related items** - Use matching `groupIds` arrays
6. **Use the color palette** - Stick to Excalidraw's built-in colors for consistency

## Diagram Types You Can Create

| Type | Description |
|------|-------------|
| **Flowcharts** | Process flows, algorithms, decision trees |
| **Sequence Diagrams** | API calls, user interactions, message flows |
| **Architecture Diagrams** | System design, microservices, infrastructure |
| **Mind Maps** | Brainstorming, concept mapping, idea organization |
| **Data Flow Diagrams** | Data movement, system analysis |
| **ERD** | Database schemas, entity relationships |
| **Wireframes** | UI mockups, layout sketches |

## Reference Documentation

- **[diagram-patterns.md](diagram-patterns.md)** - Professional patterns for each diagram type (flowcharts, sequence diagrams, mind maps, architecture, etc.)
- **[examples.md](examples.md)** - Complete working JSON examples you can use as templates
- **[element-reference.md](element-reference.md)** - Full property reference for all element types
- **[best-practices.md](best-practices.md)** - Design tips, color theory, typography guidelines

## Quick Tips for Beautiful Diagrams

1. **Use `roughness: 0`** for formal/technical diagrams, `roughness: 1` for friendly sketches
2. **Use `fontFamily: 2`** (Helvetica) for professional look, `fontFamily: 1` (Virgil) only when casual look is requested
3. **Consistent spacing** - 100px between major elements, 50px for related items
4. **Color semantics** - Blue for info/input, Green for success/data, Yellow for decisions, Red for errors
5. **Arrow conventions** - Solid for actions, Dashed for responses/async