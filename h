[33mcommit b51340dbe0e42991318553a6511452635f63e624[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m, [m[1;31morigin/main[m[33m)[m
Author: Rodrigo <kruszewskirio@gmail.com>
Date:   Fri Sep 18 22:58:19 2026 +0200

    add chat and voice widget script tags

[1mdiff --git a/web-intake/index.html b/web-intake/index.html[m
[1mindex 2f5b7ab..36fb411 100644[m
[1m--- a/web-intake/index.html[m
[1m+++ b/web-intake/index.html[m
[36m@@ -100,5 +100,7 @@[m [mdocument.getElementById('leadForm').addEventListener('submit', async (e) => {[m
   }[m
 });[m
 </script>[m
[32m+[m[32m<script src="https://broker-ai-system-2026-8472.vercel.app/widget.js"></script>[m
[32m+[m[32m<script src="https://broker-ai-system-2026-8472.vercel.app/voice-widget.js"></script>[m
 </body>[m
 </html>[m
\ No newline at end of file[m
