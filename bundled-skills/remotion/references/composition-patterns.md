# Remotion Composition Patterns

## Project Structure

```
my-video/
├── src/
│   ├── index.ts              # registerRoot entry point
│   ├── Root.tsx              # <Composition> declarations
│   └── MyVideo/
│       ├── index.tsx         # Main component
│       └── styles.ts         # Optional styles
├── public/                   # Static assets (images, fonts, audio)
├── remotion.config.ts        # Remotion config
├── package.json
└── tsconfig.json
```

## Basic Composition (Root.tsx)

```tsx
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo";

export const RemotionRoot = () => (
  <>
    <Composition
      id="MyVideo"
      component={MyVideo}
      durationInFrames={300}   // 10s at 30fps
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ title: "Hello World" }}
    />
  </>
);
```

## Common Aspect Ratios

- **16:9 landscape (YouTube):** 1920x1080 or 1280x720
- **9:16 vertical (Reels/TikTok/Shorts):** 1080x1920
- **4:5 Instagram feed:** 1080x1350
- **1:1 square:** 1080x1080

## Key Remotion APIs

```tsx
import {
  useCurrentFrame,      // Current frame number
  useVideoConfig,       // { fps, width, height, durationInFrames }
  interpolate,          // Map frame ranges to values
  spring,               // Physics-based spring animation
  Sequence,             // Time-offset children
  AbsoluteFill,         // Full-frame container
  Img,                  // Image component (preloads)
  Audio,                // Audio component
  Video,                // Video component
  staticFile,           // Reference files in public/
  delayRender,          // Hold render until async ready
  continueRender,       // Resume after delayRender
} from "remotion";
```

## Animation Example

```tsx
import { useCurrentFrame, interpolate, spring, useVideoConfig, AbsoluteFill } from "remotion";

export const FadeInText: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const scale = spring({ frame, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill className="items-center justify-center bg-black">
      <h1
        style={{ opacity, transform: `scale(${scale})` }}
        className="text-white text-7xl font-bold"
      >
        {text}
      </h1>
    </AbsoluteFill>
  );
};
```

## Sequences (Timing)

```tsx
<AbsoluteFill>
  <Sequence from={0} durationInFrames={60}>
    <Intro />
  </Sequence>
  <Sequence from={60} durationInFrames={120}>
    <MainContent />
  </Sequence>
  <Sequence from={180}>
    <Outro />
  </Sequence>
</AbsoluteFill>
```

## Input Props (Dynamic Data)

Pass data via `--props` flag or `defaultProps`:

```tsx
// Component
export const MyVideo: React.FC<{ title: string; items: string[] }> = ({ title, items }) => { ... };

// Render with props
// npx remotion render MyVideo --props='{"title":"Demo","items":["a","b"]}'
```

## Audio

```tsx
import { Audio, staticFile, Sequence } from "remotion";

<Sequence from={0}>
  <Audio src={staticFile("bgm.mp3")} volume={0.5} />
</Sequence>
```

## Fetching Data (delayRender)

```tsx
const [data, setData] = useState(null);
const [handle] = useState(() => delayRender());

useEffect(() => {
  fetch("https://api.example.com/data")
    .then((r) => r.json())
    .then((d) => { setData(d); continueRender(handle); });
}, []);
```

## TailwindCSS

Remotion supports Tailwind out of the box when scaffolded with `--tailwind`. Use className as normal on any element.