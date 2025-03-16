#\!/bin/bash

# Create a simple 16x16 tray icon
convert -size 16x16 xc:blue -fill white -font Arial -pointsize 12 -annotate +2+12 "W" public/icons/tray-icon.png

# Create a simple 128x128 app icon
convert -size 128x128 xc:blue -fill white -font Arial -pointsize 80 -annotate +35+85 "W" public/icons/icon.png

echo "Icons created successfully\!"
