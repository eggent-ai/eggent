---
name: remotion
description: AI video production workflow using Remotion. Use when creating videos, short films, commercials, or motion graphics. Triggers on requests to make promotional videos, product demos, social media videos, animated explainers, or any programmatic video content. Produces polished motion graphics, not slideshows.
---

# Video Generator (Remotion)

Create professional motion graphics videos programmatically with React and Remotion.

## Default Workflow (ALWAYS follow this)

1. **Scrape brand data** (if featuring a product) using Firecrawl
2. **Create the project** in `output/<project-name>/`
3. **Build all scenes** with proper motion graphics
4. **Install dependencies** with `npm install`
5. **Fix package.json scripts** to use `npx remotion` (not `bun`):
   ```json
   "scripts": {
     "dev": "npx remotion studio",
     "build": "npx remotion bundle"
   }
   ```
5. **Start Remotion Studio** as a background process:
   ```bash
   cd output/<project-name> && npm run dev
   ```
   Wait for "Server ready" on port 3000.
6. **Expose via Cloudflare tunnel** so user can access it:
   ```bash
   bash skills/cloudflare-tunnel/scripts/tunnel.sh start 3000
   ```
7. **Send the user the public URL** (e.g. `https://xxx.trycloudflare.com`)

The user will preview in their browser, request changes, and you edit the source files. Remotion hot-reloads automatically.

### Rendering (only when user explicitly asks to export):
```bash
cd output/<project-name>
npx remotion render CompositionName out/video.mp4
```

## Quick Start

```bash
# Scaffold project
cd output && npx --yes create-video@latest my-video --template blank
cd my-video && npm install

# Add motion libraries
npm install lucide-react

# Fix scripts in package.json (replace any "bun" references with "npx remotion")

# Start dev server
npm run dev

# Expose publicly
bash skills/cloudflare-tunnel/scripts/tunnel.sh start 3000
```

## Fetching Brand Data with Firecrawl

**MANDATORY:** When a video mentions or features any product/company, use Firecrawl to scrape the product's website for brand data, colors, screenshots, and copy BEFORE designing the video. This ensures visual accuracy and brand consistency.

API Key: Set `FIRECRAWL_API_KEY` in `.env` (see TOOLS.md).

### Usage

```bash
bash scripts/firecrawl.sh "https://example.com"
```

Returns structured brand data: brandName, tagline, headline, description, features, logoUrl, faviconUrl, primaryColors, ctaText, socialLinks, plus screenshot URL and OG image URL.

### Download Assets After Scraping

```bash
mkdir -p public/images/brand
curl -s "https://example.com/favicon.svg" -o public/images/brand/logo.svg
curl -s "${OG_IMAGE_URL}" -o public/images/brand/og-image.png
curl -sL "${SCREENSHOT_URL}" -o public/images/brand/screenshot.png
```

## Core Architecture

### Scene Management

Use scene-based architecture with proper transitions:

```tsx
const SCENE_DURATIONS: Record<string, number> = {
  intro: 3000,     // 3s hook
  problem: 4000,   // 4s dramatic
  solution: 3500,  // 3.5s reveal
  features: 5000,  // 5s showcase
  cta: 3000,       // 3s close
};
```

### Video Structure Pattern

```tsx
import {
  AbsoluteFill, Sequence, useCurrentFrame,
  useVideoConfig, interpolate, spring,
  Img, staticFile, Audio,
} from "remotion";

export const MyVideo = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill>
      {/* Background music */}
      <Audio src={staticFile("audio/bg-music.mp3")} volume={0.35} />

      {/* Persistent background layer - OUTSIDE sequences */}
      <AnimatedBackground frame={frame} />

      {/* Scene sequences */}
      <Sequence from={0} durationInFrames={90}>
        <IntroScene />
      </Sequence>
      <Sequence from={90} durationInFrames={120}>
        <FeatureScene />
      </Sequence>
    </AbsoluteFill>
  );
};
```

## Motion Graphics Principles

### AVOID (Slideshow patterns)

- Fading to black between scenes
- Centered text on solid backgrounds
- Same transition for everything
- Linear/robotic animations
- Static screens
- `slideLeft`, `slideRight`, `crossDissolve`, `fadeBlur` presets
- Emoji icons — NEVER use emoji, always use Lucide React icons

### PURSUE (Motion graphics)

- Overlapping transitions (next starts BEFORE current ends)
- Layered compositions (background/midground/foreground)
- Spring physics for organic motion
- Varied timing (2-5s scenes, mixed rhythms)
- Continuous visual elements across scenes
- Custom transitions with clipPath, 3D transforms, morphs
- Lucide React for ALL icons (`npm install lucide-react`) — never emoji

## Transition Techniques

1. **Morph/Scale** - Element scales up to fill screen, becomes next scene's background
2. **Wipe** - Colored shape sweeps across, revealing next scene
3. **Zoom-through** - Camera pushes into element, emerges into new scene
4. **Clip-path reveal** - Circle/polygon grows from point to reveal
5. **Persistent anchor** - One element stays while surroundings change
6. **Directional flow** - Scene 1 exits right, Scene 2 enters from right
7. **Split/unfold** - Screen divides, panels slide apart
8. **Perspective flip** - Scene rotates on Y-axis in 3D

## Animation Timing Reference

```tsx
// Timing values (in seconds)
const timing = {
  micro: 0.1-0.2,      // Small shifts, subtle feedback
  snappy: 0.2-0.4,     // Element entrances, position changes
  standard: 0.5-0.8,   // Scene transitions, major reveals
  dramatic: 1.0-1.5,   // Hero moments, cinematic reveals
};

// Spring configs
const springs = {
  snappy: { stiffness: 400, damping: 30 },
  bouncy: { stiffness: 300, damping: 15 },
  smooth: { stiffness: 120, damping: 25 },
};
```

## Visual Style Guidelines

### Typography
- One display font + one body font max
- Massive headlines, tight tracking
- Mix weights for hierarchy
- Keep text SHORT (viewers can't pause)

### Colors
- **Use brand colors from Firecrawl scrape** as the primary palette — match the product's actual look
- **Avoid purple/indigo gradients** unless the brand uses them or the user explicitly requests them
- Simple, clean backgrounds are generally best — a single dark tone or subtle gradient beats layered textures
- Intentional accent colors pulled from the brand

### Layout
- Use asymmetric layouts, off-center type
- Edge-aligned elements create visual tension
- Generous whitespace as design element
- Use depth sparingly — a subtle backdrop blur or single gradient, not stacked textures

## Remotion Essentials

### Interpolation

```tsx
const opacity = interpolate(frame, [0, 30], [0, 1], {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp"
});

const scale = spring({
  frame, fps,
  from: 0.8, to: 1,
  durationInFrames: 30,
  config: { damping: 12 }
});
```

### Sequences with Overlap

```tsx
<Sequence from={0} durationInFrames={100}>
  <Scene1 />
</Sequence>
<Sequence from={80} durationInFrames={100}>
  <Scene2 />
</Sequence>
```

### Cross-Scene Continuity

Place persistent elements OUTSIDE Sequence blocks:

```tsx
const PersistentShape = ({ currentScene }: { currentScene: number }) => {
  const positions = {
    0: { x: 100, y: 100, scale: 1, opacity: 0.3 },
    1: { x: 800, y: 200, scale: 2, opacity: 0.5 },
    2: { x: 400, y: 600, scale: 0.5, opacity: 1 },
  };

  return (
    <motion.div
      animate={positions[currentScene]}
      transition={{ duration: 0.8, ease: "easeInOut" }}
      className="absolute w-32 h-32 rounded-full bg-gradient-to-r from-coral to-orange"
    />
  );
};
```

## Quality Tests

Before delivering, verify:

- **Mute test:** Story follows visually without sound?
- **Squint test:** Hierarchy visible when squinting?
- **Timing test:** Motion feels natural, not robotic?
- **Consistency test:** Similar elements behave similarly?
- **Slideshow test:** Does NOT look like PowerPoint?
- **Loop test:** Video loops smoothly back to start?

## Implementation Steps

1. **Firecrawl brand scrape** — If featuring a product, scrape its site first
2. **Director's treatment** — Write vibe, camera style, emotional arc
3. **Visual direction** — Colors, fonts, brand feel, animation style
4. **Scene breakdown** — List every scene with description, duration, text, transitions
5. **Plan assets** — User assets + generated images/videos + brand scrape assets
9. **Define durations** — Vary pacing (2-3s punchy, 4-5s dramatic)
10. **Build persistent layer** — Animated background outside scenes
11. **Build scenes** — Each with enter/exit animations, 3-5 timed moments
12. **Open with hook** — High-impact first scene
13. **Develop narrative** — Content-driven middle scenes
14. **Strong ending** — Intentional, resolved close
15. **Start Remotion Studio** — `npm run dev` on port 3000
16. **Expose via tunnel** — `bash skills/cloudflare-tunnel/scripts/tunnel.sh start 3000`
17. **Send user the public URL** — They preview and request changes live
18. **Iterate** — Edit source, hot-reload, repeat
19. **Render** — Only when user says to export final video

## File Structure

```
my-video/
├── src/
│   ├── Root.tsx              # Composition definitions
│   ├── index.ts              # Entry point
│   ├── index.css             # Global styles
│   ├── MyVideo.tsx           # Main video component
│   └── scenes/               # Scene components (optional)
├── public/
│   ├── images/
│   │   └── brand/            # Firecrawl-scraped assets
│   └── audio/                # Background music
├── remotion.config.ts
└── package.json
```

## Common Components

See `references/components.md` for reusable:
- Animated backgrounds
- Terminal windows
- Feature cards
- Stats displays
- CTA buttons
- Text reveal animations

## Tunnel Management

```bash
# Start tunnel (exposes port 3000 publicly)
bash skills/cloudflare-tunnel/scripts/tunnel.sh start 3000

# Check status
bash skills/cloudflare-tunnel/scripts/tunnel.sh status 3000

# List all tunnels
bash skills/cloudflare-tunnel/scripts/tunnel.sh list

# Stop tunnel
bash skills/cloudflare-tunnel/scripts/tunnel.sh stop 3000
```