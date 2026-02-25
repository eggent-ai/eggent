# Excalidraw Element Reference

Complete property reference for all Excalidraw element types.

## Common Properties (All Elements)

Every element must include these properties:

```json
{
  "id": "unique-id",
  "type": "rectangle",
  "x": 0,
  "y": 0,
  "width": 100,
  "height": 100,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "seed": 12345,
  "version": 1,
  "versionNonce": 12345,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false
}
```

### Property Details

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique identifier. Use descriptive names like `"header-box"` |
| `type` | string | Element type (see types below) |
| `x` | number | X coordinate (left edge) |
| `y` | number | Y coordinate (top edge) |
| `width` | number | Width in pixels |
| `height` | number | Height in pixels |
| `angle` | number | Rotation in radians (0 = no rotation) |
| `strokeColor` | string | Border/line color (hex) |
| `backgroundColor` | string | Fill color (hex or `"transparent"`) |
| `fillStyle` | string | `"solid"`, `"hachure"`, `"cross-hatch"` |
| `strokeWidth` | number | `1` (thin), `2` (medium), `4` (bold) |
| `strokeStyle` | string | `"solid"`, `"dashed"`, `"dotted"` |
| `roughness` | number | `0` (architect), `1` (artist), `2` (cartoonist) |
| `opacity` | number | 0-100 (100 = fully opaque) |
| `seed` | number | Random seed for hand-drawn rendering |
| `version` | number | Element version (start at 1) |
| `versionNonce` | number | Random nonce for version |
| `isDeleted` | boolean | Soft delete flag (use `false`) |
| `groupIds` | array | IDs of groups this element belongs to |
| `boundElements` | array/null | Elements bound to this (arrows, text) |
| `link` | string/null | URL link attached to element |
| `locked` | boolean | Prevent editing |

---

## Rectangle

```json
{
  "type": "rectangle",
  "id": "rect-1",
  "x": 100,
  "y": 100,
  "width": 200,
  "height": 100,
  "roundness": { "type": 3 },
  ... common properties
}
```

### Rectangle-Specific Properties

| Property | Type | Description |
|----------|------|-------------|
| `roundness` | object/null | `{ "type": 3 }` for rounded corners, `null` for sharp |

---

## Ellipse

```json
{
  "type": "ellipse",
  "id": "ellipse-1",
  "x": 100,
  "y": 100,
  "width": 150,
  "height": 150,
  ... common properties
}
```

Note: For a perfect circle, set `width` equal to `height`.

---

## Diamond

```json
{
  "type": "diamond",
  "id": "diamond-1",
  "x": 100,
  "y": 100,
  "width": 120,
  "height": 120,
  ... common properties
}
```

Diamonds are rotated squares - useful for decision nodes in flowcharts.

---

## Text

```json
{
  "type": "text",
  "id": "text-1",
  "x": 100,
  "y": 100,
  "width": 200,
  "height": 50,
  "text": "Your text here",
  "fontSize": 20,
  "fontFamily": 1,
  "textAlign": "left",
  "verticalAlign": "top",
  "containerId": null,
  "originalText": "Your text here",
  "autoResize": true,
  "lineHeight": 1.25,
  ... common properties
}
```

### Text-Specific Properties

| Property | Type | Values |
|----------|------|--------|
| `text` | string | The displayed text (supports `\n` for newlines) |
| `fontSize` | number | Common: `16`, `20`, `28`, `36` |
| `fontFamily` | number | `1` (Virgil/hand), `2` (Helvetica), `3` (Cascadia/code) |
| `textAlign` | string | `"left"`, `"center"`, `"right"` |
| `verticalAlign` | string | `"top"`, `"middle"` |
| `containerId` | string/null | ID of container element (for bound text) |
| `originalText` | string | Original text (same as `text` unless edited) |
| `autoResize` | boolean | Auto-resize container to fit |
| `lineHeight` | number | Line spacing multiplier (default: 1.25) |

---

## Arrow

```json
{
  "type": "arrow",
  "id": "arrow-1",
  "x": 100,
  "y": 100,
  "width": 200,
  "height": 0,
  "points": [[0, 0], [200, 0]],
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "startBinding": null,
  "endBinding": null,
  ... common properties
}
```

### Arrow-Specific Properties

| Property | Type | Description |
|----------|------|-------------|
| `points` | array | Array of [x, y] points relative to element origin |
| `startArrowhead` | string/null | `null`, `"arrow"`, `"bar"`, `"dot"`, `"triangle"` |
| `endArrowhead` | string/null | `null`, `"arrow"`, `"bar"`, `"dot"`, `"triangle"` |
| `startBinding` | object/null | Binding to start element |
| `endBinding` | object/null | Binding to end element |

### Arrow Points

Points are relative to the arrow's x, y position:
- First point is always `[0, 0]`
- Subsequent points define the path
- Width/height should match the bounding box of points

```json
// Straight horizontal arrow (200px long)
"points": [[0, 0], [200, 0]]

// Straight vertical arrow (150px down)
"points": [[0, 0], [0, 150]]

// L-shaped arrow
"points": [[0, 0], [100, 0], [100, 100]]

// Curved arrow (3+ points creates curves)
"points": [[0, 0], [50, -30], [100, 0]]
```

### Binding Objects

```json
{
  "startBinding": {
    "elementId": "rect-1",
    "focus": 0,
    "gap": 5
  },
  "endBinding": {
    "elementId": "rect-2",
    "focus": 0,
    "gap": 5
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `elementId` | string | ID of the bound element |
| `focus` | number | -1 to 1, position along the edge (0 = center) |
| `gap` | number | Pixels gap between arrow and shape |

---

## Line

Same as arrow but without arrowheads by default:

```json
{
  "type": "line",
  "id": "line-1",
  "x": 100,
  "y": 100,
  "width": 200,
  "height": 0,
  "points": [[0, 0], [200, 0]],
  "startArrowhead": null,
  "endArrowhead": null,
  ... common properties
}
```

---

## Freedraw

Hand-drawn paths:

```json
{
  "type": "freedraw",
  "id": "freedraw-1",
  "x": 100,
  "y": 100,
  "width": 150,
  "height": 80,
  "points": [[0, 0], [10, 5], [20, 3], [30, 8], ...],
  "pressures": [0.5, 0.6, 0.7, ...],
  "simulatePressure": true,
  ... common properties
}
```

### Freedraw-Specific Properties

| Property | Type | Description |
|----------|------|-------------|
| `points` | array | Dense array of [x, y] points |
| `pressures` | array | Pressure values 0-1 for each point |
| `simulatePressure` | boolean | Simulate pen pressure |

---

## Frame

Groups elements visually:

```json
{
  "type": "frame",
  "id": "frame-1",
  "x": 50,
  "y": 50,
  "width": 500,
  "height": 400,
  "name": "My Frame",
  ... common properties
}
```

Child elements should have `frameId` set to the frame's ID.

---

## Image

```json
{
  "type": "image",
  "id": "image-1",
  "x": 100,
  "y": 100,
  "width": 300,
  "height": 200,
  "fileId": "file-abc123",
  "status": "saved",
  "scale": [1, 1],
  ... common properties
}
```

The actual image data goes in the top-level `files` object:

```json
{
  "files": {
    "file-abc123": {
      "id": "file-abc123",
      "mimeType": "image/png",
      "dataURL": "data:image/png;base64,..."
    }
  }
}
```

---

## Bound Elements

When text is inside a shape, or arrows connect shapes:

### Shape with bound text:
```json
{
  "type": "rectangle",
  "id": "rect-1",
  "boundElements": [
    { "id": "text-1", "type": "text" }
  ]
}
```

### Text bound to shape:
```json
{
  "type": "text",
  "id": "text-1",
  "containerId": "rect-1"
}
```

### Shape with bound arrow:
```json
{
  "type": "rectangle",
  "id": "rect-1",
  "boundElements": [
    { "id": "arrow-1", "type": "arrow" }
  ]
}
```

---

## Groups

To group elements, give them matching `groupIds`:

```json
{
  "type": "rectangle",
  "id": "rect-1",
  "groupIds": ["group-1"]
}
{
  "type": "text",
  "id": "text-1",
  "groupIds": ["group-1"]
}
```

Nested groups use multiple IDs (innermost first):
```json
"groupIds": ["inner-group", "outer-group"]
```