cmake_minimum_required(VERSION 3.24)
project(GDS_wasm)



# QHULL
set(BUILD_SHARED_LIBS OFF)
set(BUILD_APPLICATIONS OFF)
set(QHULL_ENABLE_TESTING OFF)
add_subdirectory(./external/qhull)


# GDSTK
# Had to add this two lines because I was having problems with the "find_package(Qhull 8 REQUIRED)" defined in the gdtsk repo
set(QHULL_INCLUDE_DIRS "${CMAKE_SOURCE_DIR}/external/qhull/src")
add_library(QHULL::QHULL ALIAS qhull_r)

add_subdirectory(./external/gdstk)
add_subdirectory(./external/CDT/CDT CDT)

add_subdirectory(src)
set_target_properties(gds_processor PROPERTIES 
    # RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/../src
)
# install(TARGETS gds_processor RUNTIME DESTINATION ${CMAKE_SOURCE_DIR}/public/gds_explorer)

