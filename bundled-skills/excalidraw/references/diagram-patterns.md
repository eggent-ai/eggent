# Professional Diagram Patterns

Patterns and techniques for creating beautiful, professional diagrams based on Excalidraw best practices.

## Flowcharts

### Standard Flowchart Symbols
| Shape | Meaning | Excalidraw Type |
|-------|---------|-----------------|
| Rounded rectangle | Start/End (Terminal) | `rectangle` with `roundness` |
| Rectangle | Process/Action | `rectangle` |
| Diamond | Decision | `diamond` |
| Parallelogram | Input/Output | `rectangle` rotated or use lines |
| Circle | Connector/Reference | `ellipse` |

### Swimlane Flowcharts
Organize by responsibility using frames or colored regions:

```
┌─────────────────┬─────────────────┬─────────────────┐
│     User        │     System      │    Database     │
├─────────────────┼─────────────────┼─────────────────┤
│  ┌─────────┐    │                 │                 │
│  │ Request │────┼──►┌─────────┐   │                 │
│  └─────────┘    │   │ Process │───┼──►┌─────────┐   │
│                 │   └─────────┘   │   │  Query  │   │
│                 │                 │   └─────────┘   │
└─────────────────┴─────────────────┴─────────────────┘
```

**Implementation tips:**
- Use large rectangles with `backgroundColor: "transparent"` and `strokeStyle: "dashed"` for lanes
- Add lane headers at top with bold text
- Keep elements within their lanes
- Horizontal arrows cross lane boundaries

### Color Coding for Flowcharts
- Start/End: `#b2f2bb` (green)
- Process: `#a5d8ff` (blue)
- Decision: `#ffec99` (yellow)
- Error/Exception: `#ffc9c9` (red)

---

## Sequence Diagrams

### Core Components

**1. Actors/Participants (top row)**
```json
{
  "type": "rectangle",
  "backgroundColor": "#a5d8ff",
  "width": 100,
  "height": 50,
  "roundness": { "type": 3 }
}
```

**2. Lifelines (vertical dashed lines)**
```json
{
  "type": "line",
  "strokeStyle": "dashed",
  "strokeWidth": 1,
  "roughness": 0,
  "points": [[0, 0], [0, 400]]
}
```

**3. Synchronous Messages (solid arrows)**
```json
{
  "type": "arrow",
  "strokeStyle": "solid",
  "endArrowhead": "arrow"
}
```

**4. Asynchronous Messages (dashed arrows)**
```json
{
  "type": "arrow",
  "strokeStyle": "dashed",
  "endArrowhead": "arrow"
}
```

**5. Return Messages (dashed, pointing back)**
```json
{
  "type": "arrow",
  "strokeStyle": "dashed",
  "strokeColor": "#868e96",
  "endArrowhead": "arrow"
}
```

**6. Activation Boxes (thin rectangles on lifelines)**
```json
{
  "type": "rectangle",
  "width": 16,
  "height": 80,
  "backgroundColor": "#e9ecef",
  "strokeWidth": 1
}
```

### Sequence Diagram Layout
```
     User          Auth          Database
      │             │               │
      │───Login────►│               │
      │             │──Query User──►│
      │             │◄──User Data───│
      │◄──Token─────│               │
      │             │               │
```

- Spacing: 200px between participants
- Message vertical spacing: 50-80px
- Label messages above arrows
- Number messages for complex flows: "1. Login", "2. Verify", etc.

---

## Mind Maps

### Radial Layout Pattern
Central idea with branches radiating outward:

```
                    ┌─────────┐
                    │ Topic A │
                    └────┬────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────┴────┐     ┌─────┴─────┐    ┌────┴────┐
   │ Sub 1   │     │  CENTRAL  │    │ Sub 2   │
   └─────────┘     │   IDEA    │    └─────────┘
                   └─────┬─────┘
                         │
                    ┌────┴────┐
                    │ Topic B │
                    └─────────┘
```

### Mind Map Color Strategy
- Center: Bold color (`#228be6` blue or `#7950f2` purple)
- Level 1 branches: Distinct colors for each
- Level 2+: Lighter shades of parent color

### Branch Styling
- Use curved lines (multiple points) for organic feel
- Thicker lines closer to center (`strokeWidth: 4` → `2` → `1`)
- Branches spread at 45-60° angles

### Mind Map Element Sizes
| Level | Font Size | Shape Size | Stroke Width |
|-------|-----------|------------|--------------|
| Center | 28-36 | 180x100 | 4 |
| Level 1 | 20-24 | 140x70 | 2 |
| Level 2 | 16-18 | 100x50 | 2 |
| Level 3 | 14-16 | 80x40 | 1 |

---

## Software Architecture Diagrams

### Layered Architecture
Stack components vertically with clear boundaries:

```
┌─────────────────────────────────────────┐
│           Presentation Layer            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │   Web   │  │ Mobile  │  │   API   │  │
│  └─────────┘  └─────────┘  └─────────┘  │
├─────────────────────────────────────────┤
│            Business Layer               │
│  ┌─────────────────────────────────┐    │
│  │         Service Logic           │    │
│  └─────────────────────────────────┘    │
├─────────────────────────────────────────┤
│              Data Layer                 │
│  ┌─────────┐         ┌─────────┐        │
│  │   DB    │         │  Cache  │        │
│  └─────────┘         └─────────┘        │
└─────────────────────────────────────────┘
```

**Layer colors (top to bottom):**
- Presentation: `#a5d8ff` (blue)
- Business: `#b2f2bb` (green)
- Data: `#d0bfff` (purple)

### Microservices Pattern
Independent services with API gateway:

```
                    ┌─────────────┐
                    │   Clients   │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │ API Gateway │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
    │  Service A  │ │  Service B  │ │  Service C  │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
    ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
    │    DB A     │ │    DB B     │ │    DB C     │
    └─────────────┘ └─────────────┘ └─────────────┘
```

### Component Shapes by Type
| Component | Shape | Color |
|-----------|-------|-------|
| User/Client | Ellipse or stick figure | `#a5d8ff` |
| Service/API | Rectangle | `#b2f2bb` |
| Database | Ellipse (cylinder look) | `#d0bfff` |
| Queue/Message | Rectangle with wavy side | `#ffec99` |
| External System | Rectangle with double border | `#e9ecef` |
| Load Balancer | Diamond | `#99e9f2` |

---

## Data Flow Diagrams (DFD)

### Yourdon-Coad Notation
| Symbol | Meaning | Excalidraw |
|--------|---------|------------|
| Circle | Process | `ellipse` |
| Rectangle | External Entity | `rectangle` |
| Open Rectangle | Data Store | `rectangle` without one side (use lines) |
| Arrow | Data Flow | `arrow` |

### Gane-Sarson Notation
| Symbol | Meaning | Excalidraw |
|--------|---------|------------|
| Rounded Rectangle | Process | `rectangle` with `roundness` |
| Rectangle | External Entity | `rectangle` |
| Open Rectangle | Data Store | Same as above |
| Arrow | Data Flow | `arrow` |

### DFD Levels
- **Context (Level 0)**: Single process, external entities only
- **Level 1**: Main processes, data stores appear
- **Level 2+**: Detailed sub-processes

### DFD Layout Tips
- External entities at edges
- Processes in center
- Data stores between related processes
- Label every arrow with data name

---

## Entity Relationship Diagrams

### ER Notation
```
┌─────────────┐         ┌─────────────┐
│   ENTITY    │         │   ENTITY    │
├─────────────┤         ├─────────────┤
│ attribute1  │─────────│ attribute1  │
│ attribute2  │   1:N   │ attribute2  │
│ *key*       │         │ *key*       │
└─────────────┘         └─────────────┘
```

### Cardinality Notation
Use text labels or crow's foot:
- `1` - One
- `N` or `*` - Many
- `0..1` - Zero or one
- `1..*` - One or more

---

## Common Professional Patterns

### Consistent Styling Rules
1. **All diagrams**: `roughness: 1`, `strokeWidth: 2`
2. **Formal/technical**: `roughness: 0`, `fontFamily: 2` (Helvetica)
3. **Casual/brainstorm**: `roughness: 2`, `fontFamily: 1` (Virgil)

### Visual Hierarchy
```
Title (36px, bold stroke)
    │
    ├── Primary Elements (20px, colored backgrounds)
    │       │
    │       └── Secondary Elements (16px, lighter colors)
    │               │
    │               └── Details (14px, gray text)
    │
    └── Annotations (12px, dashed borders)
```

### Arrow Conventions
| Style | Meaning |
|-------|---------|
| Solid + arrow | Primary flow, action |
| Dashed + arrow | Response, return, async |
| Solid + no head | Association, relationship |
| Dotted + arrow | Optional, reference |
| Thick solid | Main/critical path |

### Professional Color Combinations

**Corporate/Formal:**
- Primary: `#228be6` (blue)
- Secondary: `#868e96` (gray)
- Background: `#f8f9fa`

**Friendly/Startup:**
- Primary: `#7950f2` (purple)
- Secondary: `#20c997` (teal)
- Accent: `#ff922b` (orange)

**Technical/Engineering:**
- Primary: `#1e1e1e` (black)
- Background: `#e9ecef` (light gray)
- Accent: `#228be6` (blue)

---

## Quick Reference: Diagram Types

| Diagram Type | Key Shapes | Flow Direction | Best For |
|--------------|------------|----------------|----------|
| Flowchart | Rectangle, Diamond | Top→Bottom | Processes, algorithms |
| Sequence | Rectangle, Lines, Arrows | Left→Right time | Interactions, APIs |
| Mind Map | Ellipse, Lines | Center→Out | Brainstorming, concepts |
| Architecture | Rectangles, Layers | Top→Bottom | Systems, infrastructure |
| DFD | Circles, Rectangles | Various | Data movement |
| ERD | Rectangles, Lines | N/A | Database design |
| Wireframe | Rectangles, Text | N/A | UI/UX design |