# Excalidraw Design Best Practices

Guidelines for creating beautiful, professional-looking diagrams.

## Layout Principles

### Alignment
- Align elements on a grid (mentally or using coordinates)
- Keep consistent horizontal/vertical spacing between related elements
- Use multiples of 50px for spacing: 50, 100, 150, 200

### Hierarchy
- Larger elements = more important
- Use color to show relationships
- Group related items visually and with `groupIds`

### Flow Direction
- Left-to-right for processes/time
- Top-to-bottom for hierarchies
- Consistent arrow direction within a diagram

## Color Usage

### The 60-30-10 Rule
- **60%** - Background/white space
- **30%** - Primary accent color (main boxes)
- **10%** - Secondary accent (highlights, important items)

### Semantic Colors
| Color | Meaning | Hex Background | Hex Stroke |
|-------|---------|----------------|------------|
| Blue | Information, input, user | `#a5d8ff` | `#1971c2` |
| Green | Success, output, database | `#b2f2bb` | `#2f9e44` |
| Yellow | Warning, decision, process | `#ffec99` | `#f08c00` |
| Red | Error, danger, stop | `#ffc9c9` | `#e03131` |
| Purple | External, storage, special | `#d0bfff` | `#9c36b5` |
| Gray | Neutral, disabled, notes | `#e9ecef` | `#868e96` |

### Monochromatic Schemes
For minimal, professional looks:
- All shapes: `#e9ecef` background, `#1e1e1e` stroke
- Important items: `#a5d8ff` background
- Keep most elements neutral

## Typography

### Font Size Guidelines
| Use Case | Size |
|----------|------|
| Main titles | 28-36 |
| Section headers | 24 |
| Box labels | 20 |
| Descriptions | 16 |
| Notes/annotations | 14 |
| Fine print | 12 |

### Font Family Choices
- **Virgil (1)** - Default hand-drawn, casual, friendly
- **Helvetica (2)** - Clean, professional, formal
- **Cascadia (3)** - Code, technical specs, monospace

Do not use Virgil unless asked for a casual look.

### Text in Containers
- Center text horizontally and vertically
- Keep text concise (2-4 words per line)
- Use `\n` for multi-line text

## Shape Selection

### When to Use Each Shape

| Shape | Best For |
|-------|----------|
| **Rectangle** | Processes, services, containers, generic boxes |
| **Rounded Rectangle** | Buttons, cards, user-friendly elements |
| **Ellipse** | Start/end points, databases, data stores |
| **Diamond** | Decisions, conditions, branching logic |

### Shape Sizing
- Minimum: 80x60 for shapes with text
- Standard: 120x80 for process boxes
- Large: 160x100+ for containers with descriptions

## Arrow Best Practices

### Arrow Types by Usage
| Style | Use |
|-------|-----|
| Solid arrow | Primary flow, main sequence |
| Dashed arrow | Response, return, optional |
| Dotted arrow | Reference, dependency |
| No arrowhead (line) | Association, grouping |

### Arrow Routing
- Prefer horizontal or vertical arrows
- Avoid diagonal arrows when possible
- Use elbow connectors (L-shaped points) for complex routing
- Keep arrows from crossing when possible

### Binding Arrows
Always bind arrows to shapes when possible:
```json
"startBinding": { "elementId": "shape-id", "focus": 0, "gap": 5 }
```
This makes diagrams update automatically when shapes move.

## Diagram-Specific Tips

### Flowcharts
1. Start with ellipse (Start)
2. Use rectangles for processes
3. Use diamonds for decisions
4. Label arrows from decisions (Yes/No)
5. End with ellipse (End)
6. Flow top-to-bottom or left-to-right

### Architecture Diagrams
1. Group related services
2. Use color to show tiers (frontend, backend, data)
3. Label connections with protocols (HTTP, gRPC, SQL)
4. Include a legend if using many colors
5. Show boundaries with frames or large rectangles

### Sequence Diagrams
1. Actors at top as rectangles
2. Vertical dashed lines (lifelines)
3. Horizontal arrows for messages
4. Number messages in order
5. Dashed arrows for responses

### Entity Relationship Diagrams
1. Rectangles for entities
2. Include key fields as text
3. Lines for relationships
4. Label cardinality (1:N, M:N)

## Roughness Settings

| Value | Effect | Use When |
|-------|--------|----------|
| `0` | Clean, precise lines | Formal docs, technical specs |
| `1` | Slightly hand-drawn | Default, balanced look |
| `2` | Very sketchy | Brainstorming, informal |

Tip: Use `roughness: 0` for all technical documentation.

## Common Mistakes to Avoid

1. **Too many colors** - Stick to 2-3 accent colors max
2. **Inconsistent spacing** - Use the same gap everywhere
3. **Tiny text** - Minimum 14px for readability
4. **Unlabeled arrows** - Add labels for complex flows
5. **Crowded layouts** - Leave whitespace, spread out
6. **Missing legend** - Add one if using color/shape coding
7. **Crossed arrows** - Reroute to avoid crossings
8. **Inconsistent shapes** - Same concept = same shape type

## Quick Reference: Professional Template

For a clean, professional look:
```json
{
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#e9ecef",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "fontFamily": 2,
  "fontSize": 16
}
```

For highlighted/important elements:
```json
{
  "backgroundColor": "#a5d8ff",
  "strokeColor": "#1971c2"
}
```

## Responsive Sizing

When creating diagrams that might be viewed at different sizes:

- Use relative positioning (elements spaced proportionally)
- Minimum canvas size: 600x400
- Standard canvas: 800x600
- Large/complex: 1200x800+

## Testing Your Diagrams

1. Paste JSON into [excalidraw.com](https://excalidraw.com)
2. Check for visual issues
3. Verify all text is readable
4. Ensure arrows point correctly
5. Test zooming in/out