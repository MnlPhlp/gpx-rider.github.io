# Third-party notices

GPX Rider is MIT licensed (see `LICENSE`). The street imagery renderer in
`app/street-view/` contains code ported from **MapillaryJS 4.1.2**
(https://github.com/mapillary/mapillary-js), which is distributed under the
MIT license reproduced below. The ported parts are the geodetic conversions,
the camera models and pose math, the proxy-mesh decoding and clamping rules,
the projective-texturing shaders, and the blending/transition behavior they
implement — see the headers of `sfm-math.mjs`, `sfm-camera.mjs`,
`sfm-mesh.mjs`, `sfm-shaders.mjs` and `sfm-renderer.mjs`.

Street imagery shown by the app is © its Mapillary contributors under
CC BY-SA 4.0; the app credits each image on screen.

The virtual world renderer in `app/world/` uses **three.js r186 (0.186.1)**
(https://threejs.org/), vendored unmodified under `app/vendor/three/` (the
`build/` ES modules plus the `GLTFLoader`, `BufferGeometryUtils`,
`SkeletonUtils` and `lines/` addons), distributed under the MIT license in
`app/vendor/three/LICENSE` and reproduced below.

## MapillaryJS

```
MIT License

Copyright (c) Facebook, Inc. and its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## three.js

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
