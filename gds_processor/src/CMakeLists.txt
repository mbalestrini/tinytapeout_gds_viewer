cmake_minimum_required(VERSION 3.24)
project(GDS_wasm)


set(CMAKE_EXECUTABLE_SUFFIX ".js")


add_executable(gds_processor ${SOURCE_FILES} gds_processor.cpp)

include_directories(gds_processor "../external/qhull/src" "../external/gdstk/include" "../external/CDT/CDT/include") 
target_link_libraries(gds_processor qhull_r gdstk CDT)

# set(LINK_DEBUG_OPTIONS " -g -s STACK_OVERFLOW_CHECK=1 ")
# set(LINK_DEBUG_OPTIONS " -s ASSERTIONS=1 -s SAFE_HEAP=1 -s STACK_OVERFLOW_CHECK=1 ")

# https://emscripten.org/docs/porting/simd.html
# https://webassembly.org/features/
target_compile_options(gds_processor PRIVATE -msimd128 -mavx)

set_target_properties(gds_processor PROPERTIES
    LINK_FLAGS "-O3  \
    ${LINK_DEBUG_OPTIONS} \
    -s ENVIRONMENT=worker \
    -s EXPORT_ES6=1 \
    -s STACK_SIZE=1048576 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4294967296 \
    -s USE_ZLIB -s WASM=1 \
    -s FORCE_FILESYSTEM=1 \
    -s EXPORTED_FUNCTIONS='[\"_addProcessLayer\", \"_processGDS\", \"_processCells\", \"_malloc\", \"_free\"]' \
    -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"FS\"]' "
)

