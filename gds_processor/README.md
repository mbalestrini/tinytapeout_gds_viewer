# gds_processor
This directory contains the code for building `gds_processor.wasm` and `gds_processor.js`, needed by the viewer to parse GDS files, using *emscripten*


## Tools / SDKs
- cmake (tested with version 3.28)
- emsdk (tested with version 4.0.2)
- emscripten zlib port (instructions bellow) 

## External libraries
gds_processor dependes on this libraries, already included as submodules:
- qhull: https://github.com/qhull/qhull
- gdstk: https://github.com/heitzmann/gdstk
- CDT: https://github.com/artem-ogre/CDT


## zlib port
emscripten zlib port is needed to compile the code  
You can check if it's already available by running:  
`emcc --show-ports | grep zlib`  

If not, you can build it by running:  
`embuilder build zlib`


## Build instructions

```
cd gds_processor
mkdir build_release
cd build_release
cmake -DCMAKE_TOOLCHAIN_FILE=[PATH_TO_EMSDK]/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake -DCMAKE_BUILD_TYPE=Release ..
make
```

After a successful build, `gds_processor.wasm` and `gds_processor.js` should have been copied to the repo `/src` directory



