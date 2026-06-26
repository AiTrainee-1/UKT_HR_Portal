
Your own system is the better choice for this setup. Here's why, and how to do it properly.

Why On-Premise Wins Here
Your situation has one key fact that decides everything:

AiFace-Mars (biometric) → same local network → your company PC
If you use cloud hosting (Render/Railway), the biometric device needs a working internet connection every time someone punches in. If the internet goes down for even 5 minutes during morning entry, punches are lost.

On your own PC, the device talks to a local IP address — internet doesn't matter at all for attendance.

Your 8 AM – 10 PM Concern
This is perfectly fine. Think about what actually happens outside working hours:

Factory is closed → no one is punching in
No HR is working → no one needs the portal
Payroll runs during the day → already done
There is zero requirement for 24/7 uptime in your case.

Recommended Setup
Database — Local PostgreSQL
Install PostgreSQL directly on the same company PC. It's free, runs as a Windows service, and starts automatically when the PC boots.

PostgreSQL (local) ← Django ← Browser (any PC on the network)
No cloud DB needed. Your data stays inside the company network.

Django Backend — Windows Auto-Start
Install Django as a Windows service using NSSM (a free tool) so it starts the moment Windows boots — you don't need to manually start it.

# One-time setup (run as Administrator)
nssm install UKTextilesHR "python" "manage.py runserver 0.0.0.0:8000"
nssm set UKTextilesHR AppDirectory "D:\Projects\UK-textile\backend"
nssm start UKTextilesHR
After this, turning on the PC = server is running. No extra steps.

Auto Power On/Off (Optional but Recommended)
So HR doesn't need to manually turn the system on:

What	How
Auto power on at 8 AM	BIOS → Power Management → RTC Wake / Scheduled Power On
Auto shutdown at 10 PM	Windows Task Scheduler → shutdown /s /t 0 at 22:00
The PC turns itself on every morning and shuts itself off every night without anyone touching it.

Access From Other PCs in the Office
Once Django runs on 0.0.0.0:8000, every PC on the same Wi-Fi or LAN can open the portal:

http://192.168.1.xx:8000   ← your company PC's local IP
HR can use any PC or laptop in the office. No internet needed.

When Would Cloud Make Sense?
Only consider cloud (Render/Railway) if:

HR needs to access the system from home or outside the office
You want remote payroll processing after hours
You have multiple branches that need to share the same system
For a single-location garments factory used only during working hours — your own PC is simpler, cheaper (free), faster, and more reliable for biometric integration.


















This is the exact right question to ask. Here's the problem clearly:

Employee phone (4G/5G)
        ↓
   Public Internet
        ↓
   ❌ Can't reach 192.168.1.xx  ← local IP, invisible to internet
Mobile phones on their own networks can never reach a local IP. You need a public URL that points to your company PC.

Best Solution — Cloudflare Tunnel (Free)
This is made exactly for your situation. Cloudflare runs a secure tunnel from your PC outward — no port forwarding, no router changes, no static IP needed.

Employee Phone (4G/5G)
        ↓
https://api.uktextiles.com   ← public URL
        ↓
  Cloudflare Network
        ↓
  Cloudflare Tunnel (running on your PC)
        ↓
  Django (localhost:8000)
        ↓
  PostgreSQL (local)
The tunnel only works when your PC is on. When you shut down at 10 PM, the public URL becomes unreachable — which is exactly what you want.

Setup (one time, 10 minutes)
# 1. Download cloudflared and install it
# (download from cloudflare.com/products/tunnel)

# 2. Login to Cloudflare
cloudflared tunnel login

# 3. Create a tunnel
cloudflared tunnel create uktextiles

# 4. Point it to your Django server
cloudflared tunnel route dns uktextiles api.uktextiles.com

# 5. Install as Windows service (auto-starts with PC)
cloudflared service install
After this, your architecture becomes:

Who	Uses
HR in office	http://192.168.1.xx:8000 (local, fast)
Employee mobile app	https://api.uktextiles.com (public, secure)
Biometric device	http://192.168.1.xx:8000 (local, no internet needed)
All three point to the same Django server, same database. Nothing changes in your code.

What You Need
Requirement	Cost
Cloudflare account	Free
Cloudflare Tunnel	Free
A domain name (e.g. uktextiles.com)	~₹800/year
The domain is the only cost. If you don't want a domain, Cloudflare also gives you a free random subdomain like uktextiles-abc123.trycloudflare.com — but a proper domain looks more professional for employee-facing apps.

Why Not Other Options
Option	Problem
Port forwarding on router	Exposes your PC directly to internet — security risk
Move Django to Render/Railway	Biometric device now needs internet for every punch
Cloud database only	Doesn't solve mobile access to the API
Cloudflare Tunnel is the right middle ground — your data and server stay on-premise, but employees can securely reach it from anywhere.