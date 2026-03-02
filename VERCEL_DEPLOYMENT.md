# Vercel Deployment Guide

## Prerequisites

1. **Vercel Account**: Sign up at [vercel.com](https://vercel.com)
2. **Git Repository**: Push this project to GitHub, GitLab, or Bitbucket

## Deployment Steps

### Option 1: Deploy via Vercel Dashboard (Recommended)

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your Git repository
3. Vercel will auto-detect the Vite framework
4. Click **Deploy** (no configuration needed - everything is in `vercel.json`)

### Option 2: Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Login to Vercel
vercel login

# Deploy to production
vercel --prod
```

## Critical Configuration

### ✅ Already Configured

The following items are already set up in this project:

1. **COOP/COEP Headers** (`vercel.json`):
   - Required for SharedArrayBuffer (WebContainer dependency)
   - Without these headers, the terminal will not work

2. **Build Command** (`package.json`):
   - Standard Vite build: `tsc && vite build`
   - Optimized for production deployment

3. **No Local Dependencies**:
   - AI models load from CDN (@mlc-ai/web-llm)
   - No local model weights to deploy
   - All dependencies are from npm

4. **Cross-Platform Compatibility**:
   - HTML file renamed to lowercase (`index.html`)
   - All paths use forward slashes

## Post-Deployment Verification

After deployment, test the following:

### 1. Check Headers

Open Chrome DevTools → Network tab → Reload page → Check response headers:

- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`

### 2. Test WebContainer

- Open the terminal in the IDE
- Run a command like `npm init -y`
- Verify it executes without "SharedArrayBuffer is not defined" error

### 3. Test AI Model Loading

- Enter a prompt (e.g., "Create a simple Express server")
- Wait for model to download (first time: ~1-2 minutes)
- Verify code generation works

## Browser Requirements

This application requires:

- **Chrome/Edge**: Version 113 or higher
- **WebGPU Support**: For AI model inference
- **SharedArrayBuffer**: Enabled by COOP/COEP headers

## Performance Considerations

### First Load

- AI model download: ~1-2 minutes (~1GB)
- Models are cached in browser after first load
- Subsequent loads: instant (works fully offline)

### Recommended Settings

- **Region**: Auto (Vercel will choose optimal location)
- **Build Settings**: Default (Vite auto-detected)
- **Node Version**: 18.x or higher (specified in `package.json`)

## Troubleshooting

### "SharedArrayBuffer is not defined"

**Cause**: Headers not properly set  
**Solution**:

1. Verify `vercel.json` exists in root directory
2. Check Vercel deployment logs for errors
3. Clear browser cache and reload

### Model Download Fails

**Cause**: Network restrictions or browser compatibility  
**Solution**:

1. Check browser console for specific errors
2. Ensure Chrome/Edge 113+ is being used
3. Try on different network (corporate firewalls may block)

### Build Fails on Vercel

**Cause**: Missing dependencies or TypeScript errors  
**Solution**:

1. Run `npm run build` locally to verify
2. Check Vercel deployment logs for specific error
3. Ensure Node.js 18+ is available

## Environment Variables

This project does not require any environment variables for production deployment. All configuration is self-contained.

## Custom Domain (Optional)

To use a custom domain:

1. Go to your project on Vercel dashboard
2. Navigate to **Settings** → **Domains**
3. Add your domain and follow DNS configuration instructions

## Cost Considerations

- **Hobby Plan**: Free for personal projects
  - 100GB bandwidth/month
  - Unlimited deployments
  - Automatic HTTPS

- **Pro Plan**: $20/month for commercial projects
  - 1TB bandwidth/month
  - Advanced analytics

## Security Notes

1. **CORS Headers**: Already configured in `vercel.json`
2. **API Keys**: Not applicable (fully client-side application)
3. **Content Security**: Models run entirely in browser (no data sent to servers)

## Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Vite Deployment Guide](https://vitejs.dev/guide/static-deploy.html)
- [WebContainer Documentation](https://webcontainers.io/)
- [Project Documentation](./README.md)

## Support

For deployment issues:

1. Check Vercel deployment logs
2. Review browser console for errors
3. Verify browser compatibility (Chrome/Edge 113+)
4. Ensure COOP/COEP headers are present

---

**Ready to Deploy**: This project is fully configured for Vercel deployment. Simply connect your Git repository and deploy!
