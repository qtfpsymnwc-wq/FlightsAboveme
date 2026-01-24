# flights-above-me
Displays a flight directly above you in a fancy display.

Inspired by https://github.com/smartbutnot/flightportal but uses just Javascript + Browser. Uses flightradar24 free API + corsproxy.io.

Has basic PWA support for iOS, so if you open this on an iPad, you can tab Add to Home Screen and it will become a fancy display.

![Untitled design (11)](https://github.com/user-attachments/assets/1ffeea03-886f-4667-9767-490fbdec038b)

# CORS Proxy

Because flightradar24 has CORS headers you need a CORS proxy. This uses https://corsproxy.io which works well. If you go over their limits, you can sign up for their paid version for $3/mo and pass ?corskey=<apikey> to index.html

# Location

By default this shows flights above London. Go to https://bboxfinder.com if you want to find your own box. Remember that the format bbox uses is a bit different. In the coordinates format choose Lat/Long and bbox will give you coordinates in the south,west,north,east format.

For example:
```
35.317366,-81.035156,42.423457,-65.039063
```

Use this location in `index.html?bounds=<location>`

(The page will automatically flip the numbers to north,south,west,east format that FlightRadar24 expects.

# Usage

Take index.html and deploy it to your favorite static HTML hosting. For example, you can use Github Pages right here, or free Cloudflare Pages. You can download a .zip from github, upload it to Cloudflare Pages. 

Once you have a URL, you request the URL like this: `https://...URL.../index.html?bounds=<bbox bounds>&corskey=<apikey>` where bounds is the location above and corskey is optional API Key to corsproxy.io
