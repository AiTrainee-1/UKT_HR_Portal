Phase 1: The Foundation (Administrator Privileges & NSSM)
Windows strictly protects background services and network ports. Everything must be done with elevated permissions.

Open Windows PowerShell as Administrator.

Download and extract NSSM (Non-Sucking Service Manager) directly into your project root so Windows knows exactly where the executable lives:

PowerShell
cd D:\HRMS\UK-textile
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "nssm.zip"
Expand-Archive -Path "nssm.zip" -DestinationPath ".\nssm_temp" -Force
Copy-Item ".\nssm_temp\nssm-2.24\win64\nssm.exe" ".\nssm.exe"
Remove-Item -Recurse -Force ".\nssm_temp"
Remove-Item "nssm.zip"
Phase 2: The Backend (Django & Waitress)
A Python virtual environment cannot be copy-pasted between computers. It must be built fresh on the host machine.

Navigate to your backend and destroy any broken environments, then build a new one (do not touch the keyboard while it builds to prevent KeyboardInterrupt errors):

PowerShell
cd D:\HRMS\UK-textile\backend
Remove-Item -Recurse -Force ".venv"
python -m venv .venv
Activate it and install your production packages (including Waitress, your WSGI server):

PowerShell
.\.venv\Scripts\activate
pip install -r requirements.txt
pip install waitress
Open D:\HRMS\UK-textile\backend\.env and ensure Django is permitted to talk to your live domain:

Code snippet
ALLOWED_HOSTS=hrms.uktextiles.in,localhost,127.0.0.1
Phase 3: Nginx (The Traffic Cop)
Windows often blocks Port 80 for its own hidden services (like IIS). To bypass the 10013 Access Denied error, Nginx must run on Port 8080. It will serve the React frontend for the homepage and proxy API requests to Django.

Open D:\HRMS\UK-textile\nginx\conf\nginx.conf.

Configure your server block exactly like this:

Nginx
server {
    listen 8080; 
    server_name localhost hrms.uktextiles.in;

    # Serve React Frontend
    root D:/HRMS/UK-textile/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API to Django Waitress (Port 8000)
    location /api/ {
        proxy_pass         http://127.0.0.1:8000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
Test the configuration in PowerShell:

PowerShell
cd D:\HRMS\UK-textile\nginx
.\nginx.exe -t
Phase 4: Cloudflare Tunnel
Cloudflare connects your local machine to the internet securely. Since Nginx was moved to Port 8080, Cloudflare needs to know the new address.

Open D:\HRMS\UK-textile\cloudflared\config.yml.

Ensure the ingress rule points to Nginx:

YAML
ingress:
  - hostname: hrms.uktextiles.in
    service: http://localhost:8080
  - service: http_status:404
Phase 5: Installing & Starting the Background Services
Now that all files and ports are aligned, register them as Windows Services so they run silently in the background, even when VS Code is closed.

Run these installation commands in your Administrator PowerShell:

PowerShell
cd D:\HRMS\UK-textile

# Install Django Backend (Port 8000)
.\nssm.exe install UKTextilesDjango "D:\HRMS\UK-textile\backend\.venv\Scripts\python.exe"
.\nssm.exe set UKTextilesDjango AppParameters "-m waitress --host=127.0.0.1 --port=8000 config.wsgi:application"
.\nssm.exe set UKTextilesDjango AppDirectory "D:\HRMS\UK-textile\backend"

# Install Nginx (Port 8080)
.\nssm.exe install UKTextilesNginx "D:\HRMS\UK-textile\nginx\nginx.exe"
.\nssm.exe set UKTextilesNginx AppDirectory "D:\HRMS\UK-textile\nginx"

# Install Cloudflare Tunnel
.\nssm.exe install UKTextilesTunnel "D:\HRMS\UK-textile\cloudflared\cloudflared-windows-amd64.exe" "tunnel --config D:\HRMS\UK-textile\cloudflared\config.yml run hrms-prod"
.\nssm.exe set UKTextilesTunnel AppDirectory "D:\HRMS\UK-textile\cloudflared"
Start them all up:

PowerShell
.\nssm.exe start UKTextilesDjango
.\nssm.exe start UKTextilesNginx
.\nssm.exe start UKTextilesTunnel
Now that the deployment architecture is solid and running independently of your code editor, would you like to set up a quick batch script to automatically rebuild your React frontend and restart these services whenever you push a new code update?