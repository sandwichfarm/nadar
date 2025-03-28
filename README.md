# NADAR

NADAR is a tool to check where your Nostr posts are visible across different relays. It checks relays listed as online and reports their status, including latency.

## Features

- Check event visibility across multiple Nostr relays
- Support for both hex and bech32-encoded event IDs
- Real-time latency measurements
- Modern, responsive UI built with Svelte and Tailwind CSS
- Filter results by relay URL

## Development

This project uses:
- Svelte for the UI framework
- Tailwind CSS for styling
- Vite for build tooling
- TypeScript for type safety
- Vitest for testing

### Prerequisites

- Node.js 16 or later
- pnpm package manager

### Setup

1. Install dependencies:
```bash
pnpm install
```

2. Start the development server:
```bash
pnpm dev
```

3. Build for production:
```bash
pnpm build
```

4. Run tests:
```bash
pnpm test
```

## License

This project is open source and available under the MIT License. 