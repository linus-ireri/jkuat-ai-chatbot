# 🚀 Veritas AI Netlify Deployment Guide

Complete guide to deploy your Lino.AI chatbot on Netlify with a custom domain.

## 📋 Prerequisites

- A Netlify account
- A domain name (optional but recommended)
- GitHub/GitLab/Bitbucket repository with your project

## 🎯 Step-by-Step Deployment

### Step 1: Prepare Your Repository

1. Make sure your repository has:
   - All project files including the `public` folder
   - `netlify/functions` directory with your serverless functions
   - `netlify.toml` configuration file

2. **Project Structure**
   ```
   Veritas/
     ├── public/
     │   ├── index.html
     │   ├── style.css
     │   └── chat.js
     ├── netlify/
     │   └── functions/
     │       ├── askai.js
     │       ├── chat.js
     │       └── whatsapp-webhook.js
     ├── netlify.toml
     └── other project files
   ```

### Step 2: Deploy to Netlify

1. **Connect to Netlify**
   - Log in to [Netlify](https://app.netlify.com)
   - Click "New site from Git"
   - Choose your Git provider (GitHub, GitLab, or Bitbucket)
   - Select your repository

2. **Configure Build Settings**
   - Build command: (leave blank as it's a static site)
   - Publish directory: `public`
   - Click "Deploy site"

### Step 3: Set Up Custom Domain

1. **Add Your Domain**
   - Go to Netlify dashboard → Site settings → Domain management
   - Click "Add custom domain"
   - Enter your domain name
   - Click "Verify"

2. **Configure DNS**
   Option A: Use Netlify DNS (Recommended)
   - Point your domain's nameservers to Netlify's nameservers
   - Netlify will handle all DNS records

   Option B: Use Custom DNS Records
   ```
   Type  | Name    | Value
   A     | @       | Netlify's load balancer IP
   CNAME | www     | your-site-name.netlify.app
   ```

3. **Enable HTTPS**
   - Netlify automatically provisions free SSL certificates
   - Wait for DNS propagation (usually 24-48 hours)

### Step 4: Environment Variables

1. Go to Site settings → Environment variables
2. Add any necessary environment variables for your project
3. Common variables might include:
   - API keys
   - Service endpoints
   - Configuration settings

### Step 5: Test Your Deployment

1. **Check Main Functionality**
   - Visit your site at your custom domain
   - Test the chat interface
   - Verify all API endpoints are working

2. **Verify SSL**
   - Ensure HTTPS is working
   - Check for any mixed content warnings

## 🔧 Maintenance and Updates

### Deploying Updates
```bash
# Push changes to your repository
git add .
git commit -m "Update description"
git push origin main
```
- Netlify will automatically deploy updates when you push to your main branch

### Monitoring
- Use Netlify's dashboard to:
  - Monitor deployment status
  - Check function logs
  - View site analytics
  - Track form submissions (if using Netlify Forms)

## � Cost Overview

- **Netlify Hosting**: Free tier available
  - Includes 100GB bandwidth/month
  - 125K function invocations/month
- **Custom Domain**: ~$10-15/year
- **SSL Certificate**: Free with Netlify
- **Total**: ~$10-15/year (domain only)

## 🎉 Success!

Your Lino.AI chatbot is now deployed with:
- ✅ Fast global CDN
- ✅ Automatic HTTPS
- ✅ Continuous deployment
- ✅ Serverless functions
- ✅ Custom domain

---

**Built by Ireri Linus Mugendi for Veritas AI** 🤖