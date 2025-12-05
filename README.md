# REM Network Chrome Extension Miner

## Overview

Mine REM tokens directly from your Chrome browser! This lightweight extension connects to the REM Network coordinator and earns rewards by providing RAM for decentralized vector storage.

## Features

✨ **One-Click Mining** - Start mining with just a few clicks  
💰 **Earn REM Tokens** - Get rewarded for contributing resources  
📊 **Beautiful Dashboard** - Real-time stats and earnings tracking  
🔒 **Secure** - Built-in Sui wallet with Ed25519 signatures  
⚡ **Lightweight** - Runs in background without slowing your browser  
🎨 **Modern UI** - Gorgeous gradient design with glassmorphism

## Installation

### From Source

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked"
5. Select the `chrome-miner` folder
6. Done! The extension icon will appear in your toolbar

### First-Time Setup

1. Click the extension icon
2. Click "Settings" to open the setup wizard
3. Configure your RAM commitment (1-32 GB)
4. Generate a new Sui wallet or import existing one
5. Review and confirm
6. Start mining!

**Important**: Save your private key securely! You'll need it to access your REM rewards.

## Usage

### Dashboard

Click the extension icon to see:
- **Connection Status** - Online/Offline indicator
- **RAM Committed** - How much RAM you're providing
- **Vectors Stored** - Number of AI embeddings stored
- **Uptime** - How long you've been mining
- **Queries Served** - Search requests you've handled
- **Earnings** - REM tokens earned this epoch
- **Wallet Address** - Your Sui wallet address
- **Referral Code** - Your unique node ID (click 📋 to copy)

### Action Buttons

- **⚙️ Settings** - Configure your miner settings
- **📊 Details** - View your stats on the REM Network explorer

### Settings

Manage your configuration:
- Adjust RAM commitment
- View wallet address
- Change referral code
- Export/import configuration

## How It Works

1. **RAM Allocation**: Extension allocates the committed RAM in browser memory
2. **PoRAM Challenges**: Coordinator sends cryptographic challenges to verify you have the RAM
3. **Vector Storage**: Stores AI vector embeddings for similarity search
4. **Search Queries**: Executes vector searches when requested
5. **Rewards**: Earn REM tokens every epoch (1 hour) based on:
   - RAM provided
   - Uptime percentage
   - Query performance
   - PoRAM challenge scores

## Earnings Estimates

| RAM | Earnings/Epoch | Earnings/Day | Earnings/Month |
|-----|----------------|--------------|----------------|
| 2 GB | ~500 REM | ~12,000 REM | ~360,000 REM |
| 4 GB | ~1,000 REM | ~24,000 REM | ~720,000 REM |
| 8 GB | ~2,000 REM | ~48,000 REM | ~1,440,000 REM |
| 16 GB | ~4,000 REM | ~96,000 REM | ~2,880,000 REM |

*Estimates based on 98% uptime and typical network conditions*

## System Requirements

- **Browser**: Chrome 88+ (or Chromium-based)
- **RAM**: At least 2GB available
- **Internet**: Stable connection
- **Recommended**: 8GB+ total system RAM for best performance

## Troubleshooting

### Extension won't start
- Check if you have enough available RAM
- Try reducing RAM commitment in settings
- Restart browser and try again

### Not earning rewards
- Ensure you're connected (green dot in popup)
- Check your Sui wallet address is correct
- Verify uptime is >80%

### Connection issues
- Check internet connection
- Verify coordinator URL: `wss://api.getrem.online/miners_ws`
- Check browser console for errors

### High memory usage
- This is normal - you're allocating RAM for mining
- Reduce RAM commitment if needed
- Close unused tabs

## Development

### Project Structure

```
chrome-miner/
├── manifest.json          # Extension configuration
├── background.js          # Service worker (miner lifecycle)
├── popup.html/js/css      # Dashboard UI
├── setup.html/js/css      # Setup wizard
├── miner.js               # WebSocket miner client
├── engine.js              # Vector storage engine
├── poram.js               # Proof-of-RAM manager
├── crypto.js              # Sui wallet & signatures
└── icons/                 # Extension icons
```

### Building from Source

No build process required! This is vanilla JavaScript.

1. Make your changes
2. Reload extension in `chrome://extensions/`
3. Test in browser

### Testing

1. Load extension in Chrome
2. Open extension popup
3. Open browser console (F12)
4. Check logs for `[Miner]`, `[PoRAM]`, `[Engine]` messages

## Security

- ✅ Private keys stored in Chrome's encrypted storage
- ✅ No data sent to third parties
- ✅ Sui signatures verify wallet ownership
- ✅ All WebSocket communication over WSS (encrypted)
- ✅ Open source - audit the code yourself!

**Never share your private key with anyone!**

## Coordinator Compatibility

This extension is compatible with REM Network Coordinator v1.0+

- **WebSocket URL**: `wss://api.getrem.online/miners_ws`
- **Miner Secret**: Pre-configured (xuLHbzL7...)
- **Protocol Version**: v1.0
- **Embedding Dimension**: 384
- **Index Version**: 1

## Referral Program

Earn 10% bonus rewards by referring new miners!

1. Open the extension popup
2. Find your Referral Code (it's your Node ID)
3. Click the 📋 copy button to copy it
4. Share with friends
5. They enter your Node ID as referral code during setup
6. You earn 10% of their rewards forever!

## Support

- **Discord**: [discord.gg/remnetwork](https://discord.gg/remnetwork)
- **Website**: [getrem.online](https://getrem.online)
- **Docs**: [getrem.online/docs](https://getrem.online/docs)
- **GitHub**: [github.com/RemNetwork](https://github.com/RemNetwork)

## License

MIT License - see LICENSE file

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Roadmap

- [x] Basic mining functionality
- [x] Beautiful dashboard UI
- [x] Setup wizard
- [x] Sui wallet integration
- [ ] Advanced statistics page
- [ ] Settings customization
- [ ] Performance optimization
- [ ] Firefox/Edge support
- [ ] Mobile browser support

## Disclaimer

Mining cryptocurrency involves risk. REM tokens have no guaranteed value. Mine at your own discretion. This extension uses your system resources (RAM). Always ensure you have sufficient RAM for your regular activities.

---

**Made with ❤️ by the REM Network community**

Start mining today and join the decentralized AI revolution! 🚀
