#include <emscripten.h>
#include <stdio.h>
#include <stdarg.h>
#include <time.h>
#include <libqhull_r/qhull_ra.h>
#include <gdstk/gdstk.hpp>
#include <CDT.h>

// #define TEST_MERGE_SAME_LAYER_POLYS

#define ARRAY_LENGTH(some_array) (sizeof(some_array) / sizeof(some_array[0]))

using namespace gdstk;

#define INDICES_TYPE uint32_t
#define RESTART_INDEX_VALUE 0xffffffff
#define POSITIONS_TYPE float

struct layer_stack_data;
Array<layer_stack_data> g_layer_stack = {};

static char g_log_msg_buffer[1024] = {};
static gdstk::Library g_lib;
clock_t g_start_time;

template <typename T>
struct GrowBuffer;
void triangulate(Array<Polygon *> &polygons, GrowBuffer<POSITIONS_TYPE> &positions_buffer, GrowBuffer<INDICES_TYPE> &indices_buffer, float zmin, float zmax);
void createLineBuffers(Array<Polygon *> &polygons, GrowBuffer<POSITIONS_TYPE> &positions_buffer, GrowBuffer<INDICES_TYPE> &indices_buffer, float zmin, float zmax);
void processReferencesHierarchy(Library &lib);

template <typename T>
struct GrowBuffer
{
    int expansion_size = 1024 * 1024;
    int current_offset = 0;
    int allocated_size = 0;
    int items_count = 0;
    unsigned char *data = NULL;

    GrowBuffer(int reserveBufferSize)
    {
        assert(reserveBufferSize > 0);
        data = (unsigned char *)malloc(reserveBufferSize);
        assert(data);
        allocated_size = reserveBufferSize;
        current_offset = 0;
        items_count = 0;
    }
    ~GrowBuffer()
    {
        if (data != NULL)
            free(data);
    }
    GrowBuffer(const GrowBuffer &temp_obj) = delete;
    GrowBuffer &operator=(const GrowBuffer &temp_obj) = delete;

    // Clear the current offsets but doesn't free the memory
    void reset()
    {
        current_offset = 0;
        items_count = 0;
    }

    int size()
    {
        return items_count;
    }

    void insert(T value)
    {
        if (current_offset + sizeof(value) > allocated_size)
        {
            // expand
            data = (unsigned char *)realloc(data, allocated_size + expansion_size);
            assert(data);
            allocated_size += expansion_size;
        }

        memcpy(data + current_offset, &value, sizeof(value));
        current_offset += sizeof(value);
        items_count++;
    }
};

struct
{
    uint64_t total_vertices = 0;
    uint64_t total_triangles = 0;
} g_triangulation_stats;

struct layer_stack_data
{
    Tag tag;
    char name[255];
    double zmin;
    double zmax;
    layer_stack_data(Tag tag, const char *name, double zmin, double zmax) : tag(tag), zmin(zmin), zmax(zmax)
    {
        strncpy(this->name, name, 255);
        this->name[255 - 1] = '\0';
    }
};

// layer_stack_data layer_stack[] = {
//     {make_tag(235, 4), "substrate", -2, 0},
//     {make_tag(64, 20), "nwell", -2, 0},
//     {make_tag(65, 20), "diff", -0.5, 0.01},
//     {make_tag(66, 20), "poly", 0, 0.18},
//     {make_tag(66, 44), "licon", 0, 0.936},
//     {make_tag(67, 20), "li1", 0.936, 1.136},

//     {make_tag(67, 16), "li1_pin", 1.136, 1.136 + 0.02},

//     {make_tag(67, 44), "mcon", 1.011, 1.376},
//     {make_tag(68, 20), "met1", 1.376, 1.736},

//     {make_tag(68, 16), "met1_pin", 1.736, 1.736 + 0.02},

//     {make_tag(68, 44), "via", 1.73, 2},
//     {make_tag(69, 20), "met2", 2, 2.36},

//     {make_tag(69, 16), "met2_pin", 2.36, 2.36 + 0.02},

//     {make_tag(69, 44), "via2", 2.36, 2.786},
//     {make_tag(70, 20), "met3", 2.786, 3.631},
//     {make_tag(70, 44), "via3", 3.631, 4.0211},
//     {make_tag(71, 20), "met4", 4.0211, 4.8661},
//     {make_tag(71, 44), "via4", 4.8661, 5.371},
//     {make_tag(72, 20), "met5", 5.371, 6.6311},

//     // ToDo: check the correct position and heights of capm layers
//     {make_tag(89, 44), "capm", 3.631 + 0.1, 3.631 + 0.1 + 0.2},
//     {make_tag(97, 44), "cap2m", 4.0211 + 0.1, 4.0211 + 0.1 + 0.2},

// };

void JS_gds_info_log(const char *format, ...)
{
    va_list args;
    va_start(args, format);

    time_t now = clock();
    double elapsed_time = ((double)(now - g_start_time)) / CLOCKS_PER_SEC;

    vsprintf(g_log_msg_buffer, format, args);
    EM_ASM({ self.gds_info_log(UTF8ToString($0), $1); }, g_log_msg_buffer, elapsed_time);

    va_end(args);
}

void JS_gds_stats(const char *design_name, LibraryInfo &info)
{
    EM_ASM(
        { (
              var design_name = UTF8ToString($0);
              var stats = {
                  designs : $1,
                  shape_tags : $2,
                  label_tags : $3,
                  num_polygons : $4,
                  num_paths : $5,
                  num_references : $6,
                  num_labels : $7,
                  unit : $8,
                  precision : $9
              };

              gds_stats(design_name, stats);) },
        design_name,
        info.cell_names.count,
        info.shape_tags.count,
        info.label_tags.count,
        info.num_polygons,
        info.num_paths,
        info.num_references,
        info.num_labels,
        info.unit,
        info.precision);
}

void JS_gds_add_cell(const char *cell_name, Vec2 &min, Vec2 &max, bool is_top_cell)
{
    EM_ASM({ (
                 let bounds = {min_x : $1, min_y : $2, max_x : $3, max_y : $4};
                 gds_add_cell(UTF8ToString($0), bounds, $5);) }, cell_name, min.x, min.y, max.x, max.y, is_top_cell);
}

void JS_gds_add_mesh(const char *cell_name, const char *mesh_name, int tag_layer, int tag_type, GrowBuffer<POSITIONS_TYPE> &positions, GrowBuffer<INDICES_TYPE> &indices)
{
    EM_ASM({ gds_add_mesh(UTF8ToString($0), UTF8ToString($1), $2, $3, $4, $5, $6, $7, $8); }, cell_name, mesh_name, tag_layer, tag_type, positions.size(), positions.data, indices.size(), indices.data);
}

void JS_gds_add_lines(const char *cell_name, const char *mesh_name, int tag_layer, int tag_type, GrowBuffer<POSITIONS_TYPE> &positions, GrowBuffer<INDICES_TYPE> &indices)
{
    EM_ASM({ gds_add_lines(UTF8ToString($0), UTF8ToString($1), $2, $3, $4, $5, $6, $7, $8); }, cell_name, mesh_name, tag_layer, tag_type, positions.size(), positions.data, indices.size(), indices.data);
}

void JS_gds_add_label(const char *cell_name, int tag_layer, int tag_type, const char *text, double origin_x, double origin_y, double pos_z)
{
    EM_ASM({ gds_add_label(UTF8ToString($0), $1, $2, UTF8ToString($3), $4, $5, $6); }, cell_name, tag_layer, tag_type, text, origin_x, origin_y, pos_z);
}

void JS_gds_add_reference(const char *parent_cell_name, const char *cell_name, const char *instance_name, double origin_x, double origin_y, double rotation, bool x_reflection)
{
    EM_ASM({gds_add_reference(UTF8ToString($0), UTF8ToString($1), UTF8ToString($2), $3, $4, $5, $6)}, parent_cell_name, cell_name, instance_name, origin_x, origin_y, rotation, x_reflection);
}

void JS_gds_finished_references()
{
    EM_ASM({ gds_finished_references(); });
}

void JS_gds_process_progress(float progress)
{
    EM_ASM({gds_process_progress($0)}, progress);
}

void buildMeshName(char *mesh_name, const char *cell_name, const char *layer_name)
{
    sprintf(mesh_name, "%s_%s", cell_name, layer_name);
}

void print_gds_info(gdstk::LibraryInfo &lib_info)
{
    JS_gds_info_log("Info:\n");

    JS_gds_info_log("\tdesigns: %d\n", lib_info.cell_names.count);
    JS_gds_info_log("\tshape_tags #: %d\n", lib_info.shape_tags.count);
    JS_gds_info_log("\tlabel_tags #: %d\n", lib_info.label_tags.count);
    JS_gds_info_log("\tnum_polygons: %d\n", lib_info.num_polygons);
    JS_gds_info_log("\tnum_paths: %d\n", lib_info.num_paths);
    JS_gds_info_log("\tnum_references: %d\n", lib_info.num_references);
    JS_gds_info_log("\tnum_labels: %d\n", lib_info.num_labels);
    JS_gds_info_log("\tunit: %.10e\n", lib_info.unit);
    JS_gds_info_log("\tprecision: %e\n", lib_info.precision);

    JS_gds_info_log("\n");
}

bool check_extension_matches(const char *filename, const char *target_extension)
{
    const int extension_length = strlen(target_extension);    
    const int filename_len = strlen(filename);

    // Filename too short
    if(filename_len<extension_length+2 || filename[filename_len-extension_length-1]!='.')
        return false;

    int offset = (filename_len-extension_length);
    for (int i = 0; i < extension_length; i++)
    {
        if( tolower(filename[offset]) != tolower(*target_extension))
        {
            return false;
        }
        offset++;
        target_extension++;
    }

    return true;
}

bool GDSTKUTIL_is_gds_property(const Property* property) {
    if (strcmp(property->name, s_gds_property_name) != 0 || property->value == NULL) return false;
    PropertyValue* attribute = property->value;
    PropertyValue* value = attribute->next;
    if (attribute->type != PropertyType::UnsignedInteger || value == NULL ||
        value->type != PropertyType::String)
        return false;
    return true;
}

PropertyValue* GDSTKUTIL_get_first_gds_property(Property* properties) {
    while (properties && !GDSTKUTIL_is_gds_property(properties) )
        properties = properties->next;
    if (properties) return properties->value->next;
    return NULL;
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE
    void addProcessLayer(uint32_t layer_number, uint32_t layer_datatype, const char *name, double layer_zmin, double layer_zmax)
    {
        layer_stack_data layer(make_tag(layer_number, layer_datatype), name, layer_zmin, layer_zmax);
        g_layer_stack.append(layer);

        JS_gds_info_log("Add process layer %d/%d - %s (zmin:%f zmax:%f)\n", layer_number, layer_datatype, name, layer_zmin, layer_zmax);
    }
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE
    void processGDS(const char *gds_filepath, bool opt_just_lines = false)
    {
        g_start_time = clock();

        // JS_TEST_ASM();

        JS_gds_info_log("Starting process: %s\n", gds_filepath);
        JS_gds_info_log("\topt_just_lines: %d\n", opt_just_lines);
        JS_gds_process_progress(0);

        g_lib.clear();

        gdstk::LibraryInfo lib_info = {};

        if(check_extension_matches(gds_filepath, "gds"))
        {        
            gdstk::gds_info(gds_filepath, lib_info);
            print_gds_info(lib_info);
            JS_gds_process_progress(1);
            g_lib = read_gds(gds_filepath, 0, 0, NULL, NULL);
        } 
        else 
        {
            g_lib = read_oas(gds_filepath, 0, 0, NULL);
        }

        
        JS_gds_process_progress(5);

        Array<Cell *> top_cells = {};
        Array<RawCell *> top_rawcells = {};

        g_lib.top_level(top_cells, top_rawcells);
        Cell *top_cell = top_cells[0];

        JS_gds_stats(top_cell->name, lib_info);
        
        JS_gds_info_log("TOP_CELL: %s\n", top_cell->name);
        JS_gds_info_log("references: %" PRIu64 "\n", top_cell->reference_array.count);

        auto cell = top_cell;
        Array<Reference *> removed_references = {};
        // cell->flatten(true, removed_references);

        JS_gds_info_log("Start boundingbox calculation\n");
        for (uint64_t i = 0; i < g_lib.cell_array.count; i++)
        {
            Vec2 min;
            Vec2 max;
            g_lib.cell_array[i]->bounding_box(min, max);

            bool is_top_cell = (top_cells.index(g_lib.cell_array[i]) != top_cells.count);
            JS_gds_add_cell(g_lib.cell_array[i]->name, min, max, is_top_cell);
        }
        JS_gds_info_log("Finished boundingbox calculation\n");

        JS_gds_info_log("Start processing references\n");
        processReferencesHierarchy(g_lib);
        JS_gds_info_log("Finished processing references\n");
    }
}

extern "C"
{

    EMSCRIPTEN_KEEPALIVE
    void processCells(bool opt_just_lines = false)
    {
        GrowBuffer<POSITIONS_TYPE> positions_buffer(1024 * 1024);
        GrowBuffer<INDICES_TYPE> indices_buffer(1024 * 1024);

        Array<Polygon *> polygons = {};
        Array<Polygon *> polygons_copy = {};

        constexpr int depth = 0;

        JS_gds_info_log("Start processing cell\n");
        for (uint64_t i = 0; i < g_lib.cell_array.count; i++)
        {
            auto cell = g_lib.cell_array[i];
            JS_gds_info_log("Cell: %s\n", cell->name);
            JS_gds_info_log("\trefs: %" PRIu64 "\n", cell->reference_array.count);

            // LOOP LAYERS IN CELL
            int layers_count = g_layer_stack.count;
            for (int layer_idx = 0; layer_idx < layers_count; layer_idx++)
            {
                const Tag tag = g_layer_stack[layer_idx].tag;

                cell->get_polygons(true, true, depth, true, tag, polygons);

#ifdef TEST_MERGE_SAME_LAYER_POLYS
                {
                    Array<Polygon *> res_poly = {};
                    boolean(polygons, polygons, Operation::Or, 1000, res_poly);
                    polygons.clear();
                    polygons = res_poly;
                }
#endif

                if (polygons.count > 0)
                {
                    JS_gds_info_log("\t\tLayer: %d/%d\n", gdstk::get_layer(tag), gdstk::get_type(tag));
                    JS_gds_info_log("\t\t\tpolygons: %" PRIu64 "\n", polygons.count);

                    char mesh_name[1024];
                    buildMeshName(mesh_name, cell->name, g_layer_stack[layer_idx].name);

                    if (opt_just_lines)
                    {
                        // Lines
                        createLineBuffers(polygons, positions_buffer, indices_buffer, g_layer_stack[layer_idx].zmin, g_layer_stack[layer_idx].zmax);
                        JS_gds_add_lines(cell->name, mesh_name, gdstk::get_layer(tag), gdstk::get_type(tag), positions_buffer, indices_buffer);
                    }
                    else
                    {
                        // Triangles
                        triangulate(polygons, positions_buffer, indices_buffer, g_layer_stack[layer_idx].zmin, g_layer_stack[layer_idx].zmax);
                        JS_gds_add_mesh(cell->name, mesh_name, gdstk::get_layer(tag), gdstk::get_type(tag), positions_buffer, indices_buffer);
                    }
                }
                polygons.clear();
            }

            // TEST:
            // {
            //     JS_gds_info_log("\t\tTEST Negative Meshes\n");
            //     Array<Polygon *> substrate_polys = {};
            //     Array<Polygon *> result_polys = {};
            //     Vec2 min;
            //     Vec2 max;
            //     char mesh_name[1024];
            //     float zmin;
            //     float zmax;
            //     int new_tag_layer = 0;
            //     int new_tag_datatype = 0;                
            //     cell->bounding_box(min, max);            
            //     Polygon p = {};
            //     p.point_array.append({min.x, min.y});
            //     p.point_array.append({min.x, max.y});
            //     p.point_array.append({max.x, max.y});
            //     p.point_array.append({max.x, min.y});
            //     substrate_polys.append(&p);

            //     result_polys.clear();
            //     const Tag poly_tag = make_tag(66, 20);                
            //     Array<Polygon *> poly_polys = {};                
            //     cell->get_polygons(true, true, depth, true, poly_tag, poly_polys);
            //     boolean(substrate_polys, poly_polys, Operation::Not, 1000, result_polys);
            //     buildMeshName(mesh_name, cell->name, "substrate-poly");
            //     // Triangles
            //     zmin = 0.0;
            //     zmax = 0.18;
            //     triangulate(result_polys, positions_buffer, indices_buffer, zmin, zmax);
            //     JS_gds_add_mesh(cell->name, mesh_name, new_tag_layer, new_tag_datatype, positions_buffer, indices_buffer);

            //     result_polys.clear();
            //     const Tag licon_tag = make_tag(66, 44);                
            //     Array<Polygon *> licon_polys = {};                
            //     cell->get_polygons(true, true, depth, true, licon_tag, licon_polys);
            //     boolean(substrate_polys, licon_polys, Operation::Not, 1000, result_polys);                
            //     buildMeshName(mesh_name, cell->name, "substrate-licon");
            //     // Triangles
            //     zmin = 0.0;
            //     zmax = 0.936;
            //     triangulate(result_polys, positions_buffer, indices_buffer, zmin, zmax);
            //     JS_gds_add_mesh(cell->name, mesh_name, new_tag_layer, new_tag_datatype, positions_buffer, indices_buffer);

            //     result_polys.clear();
            //     const Tag li1_tag = make_tag(67, 20);                
            //     Array<Polygon *> li1_polys = {};                
            //     cell->get_polygons(true, true, depth, true, li1_tag, li1_polys);
            //     boolean(substrate_polys, li1_polys, Operation::Not, 1000, result_polys);                
            //     buildMeshName(mesh_name, cell->name, "substrate-li1");
            //     // Triangles
            //     zmin = 0.936;
            //     zmax = 1.136;
            //     triangulate(result_polys, positions_buffer, indices_buffer, zmin, zmax);
            //     JS_gds_add_mesh(cell->name, mesh_name, new_tag_layer, new_tag_datatype, positions_buffer, indices_buffer);

            //     result_polys.clear();
            //     const Tag mcon_tag = make_tag(67, 44);                
            //     Array<Polygon *> mcon_polys = {};                
            //     cell->get_polygons(true, true, depth, true, mcon_tag, mcon_polys);
            //     boolean(substrate_polys, mcon_polys, Operation::Not, 1000, result_polys);                
            //     buildMeshName(mesh_name, cell->name, "substrate-mcon");
            //     // Triangles
            //     zmin = 1.011;
            //     zmax = 1.376;
            //     triangulate(result_polys, positions_buffer, indices_buffer, zmin, zmax);
            //     JS_gds_add_mesh(cell->name, mesh_name, new_tag_layer, new_tag_datatype, positions_buffer, indices_buffer);               

            // }

            // LABELS
            
            const Tag label_layers[] = {make_tag(67, 5), make_tag(68, 5), make_tag(69, 5), make_tag(70, 5), make_tag(71, 5), make_tag(72, 5)};
            const double label_layers_heights[] = {1.136 + 0.03, 1.736 + 0.03, 2.36 + 0.03, 3.631 + 0.03, 4.8661 + 0.03, 6.6311 + 0.03};
            Array<Label *> labels = {};

            for (int layer_idx = 0; layer_idx < ARRAY_LENGTH(label_layers); layer_idx++)
            {
                const Tag tag = label_layers[layer_idx];
                const double pos_z = label_layers_heights[layer_idx];

                cell->get_labels(true, depth, true, tag, labels);

                for (uint64_t i = 0; i < labels.count; i++)
                {
                    auto label = labels[i];
                    JS_gds_add_label(cell->name, gdstk::get_layer(label->tag), gdstk::get_type(label->tag), label->text, label->origin.x, label->origin.y, pos_z);
                }

                labels.clear();
            }

            float perc = (i + 1) / (float)(g_lib.cell_array.count);
            perc = perc * 95 + 5;
            JS_gds_process_progress(perc);
        }

        JS_gds_info_log("Finished processing cell\n");

        JS_gds_info_log("Triangulation stats: total_vertices: %" PRIu64 " total_triangles: %" PRIu64 "\n", g_triangulation_stats.total_vertices, g_triangulation_stats.total_triangles);

        JS_gds_process_progress(100);
    }
}

void processReferencesHierarchy(Library &lib)
{

    for (int i = 0; i < lib.cell_array.count; i++)
    {
        auto cell = lib.cell_array[i];

        for (int j = 0; j < cell->reference_array.count; j++)
        {
            Reference *ref = cell->reference_array[j];

            const char *child_instance_name;

            // ToDo: 61 seems to be the property on sky130, but not in others?
            // For now we use the first GDS property we found as the instance name
            // properties_print(ref->properties);
            // auto *gds_instance_name_prop = gdstk::get_gds_property(ref->properties, 61);
            auto *gds_instance_name_prop = GDSTKUTIL_get_first_gds_property(ref->properties);            
            if (gds_instance_name_prop == NULL)
                child_instance_name = "???";
            else
                child_instance_name = (char *)gds_instance_name_prop->bytes;

            if (ref->repetition.type != RepetitionType::None)
            {
                Array<Vec2> offsets = {};
                ref->repetition.get_offsets(offsets);
                // repetition.clear();

                // double *offset_p = (double *)(offsets.items + 1);
                double *offset_p = (double *)(offsets.items);
                // double origin_x = ref->origin.x;
                // double origin_y = ref->origin.y;
                // result.ensure_slots(offsets.count - 1);
                for (uint64_t offset_count = offsets.count; offset_count > 0; offset_count--)
                {
                    double origin_x = ref->origin.x + *offset_p++;
                    double origin_y = ref->origin.y + *offset_p++;
                    // if (ref->type == ReferenceType::Cell && ref->cell->reference_array.count > 0)
                    // ToDo: contemplate case where ReferenceType is RawCell or just name
                    // ToDo: put a name to the array instances (use col and row indexes?)
                    JS_gds_add_reference(cell->name, ref->cell->name, child_instance_name, origin_x, origin_y, ref->rotation, ref->x_reflection);
                }

                offsets.clear();
            }
            else
            {
                // if (ref->type == ReferenceType::Cell && ref->cell->reference_array.count > 0)
                // ToDo: contemplate case where ReferenceType is RawCell or just name
                JS_gds_add_reference(cell->name, ref->cell->name, child_instance_name, ref->origin.x, ref->origin.y, ref->rotation, ref->x_reflection);
            }
        }
    }

    JS_gds_finished_references();
}

void triangulate(Array<Polygon *> &polygons, GrowBuffer<POSITIONS_TYPE> &positions_buffer, GrowBuffer<INDICES_TYPE> &indices_buffer, float zmin, float zmax)
{
    uint64_t total_triangles = 0;
    uint64_t total_vertices = 0;

    int indices_offset = 0;
    // std::vector<float> mesh_points_pos;
    // std::vector<uint32_t> mesh_indices;
    positions_buffer.reset();
    indices_buffer.reset();

    for (uint64_t j = 0; j < polygons.count; j++)
    {
        auto poly = polygons[j];

        // SOME TEST: Special case of rectangles (there are usually many more that other types of polygons, that's why is worth to handle them this way)
        if (poly->point_array.count == 4 &&
            ((poly->point_array[0].x == poly->point_array[1].x && poly->point_array[2].x == poly->point_array[3].x && poly->point_array[0].y == poly->point_array[3].y && poly->point_array[1].y == poly->point_array[2].y) ||
             (poly->point_array[0].x == poly->point_array[3].x && poly->point_array[1].x == poly->point_array[2].x && poly->point_array[0].y == poly->point_array[1].y && poly->point_array[2].y == poly->point_array[3].y)))
        {

            constexpr int total_poly_vertices = 4;

            // BOTTOM FACES
            int bottom_indices_offset = indices_offset;

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[0].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[0].y);
            positions_buffer.insert((POSITIONS_TYPE)zmin);

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[1].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[1].y);
            positions_buffer.insert((POSITIONS_TYPE)zmin);

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[2].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[2].y);
            positions_buffer.insert((POSITIONS_TYPE)zmin);

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[3].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[3].y);
            positions_buffer.insert((POSITIONS_TYPE)zmin);

            indices_buffer.insert((INDICES_TYPE)0 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)1 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)2 + indices_offset);

            indices_buffer.insert((INDICES_TYPE)0 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)2 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)3 + indices_offset);

            indices_offset += total_poly_vertices;

            // TOP FACES
            int top_indices_offset = indices_offset;

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[0].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[0].y);
            positions_buffer.insert((POSITIONS_TYPE)zmax);

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[1].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[1].y);
            positions_buffer.insert((POSITIONS_TYPE)zmax);

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[2].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[2].y);
            positions_buffer.insert((POSITIONS_TYPE)zmax);

            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[3].x);
            positions_buffer.insert((POSITIONS_TYPE)poly->point_array[3].y);
            positions_buffer.insert((POSITIONS_TYPE)zmax);

            indices_buffer.insert((INDICES_TYPE)0 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)1 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)2 + indices_offset);

            indices_buffer.insert((INDICES_TYPE)0 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)2 + indices_offset);
            indices_buffer.insert((INDICES_TYPE)3 + indices_offset);

            indices_offset += total_poly_vertices;

            // // SIDES

            for (int i = 0; i < total_poly_vertices; i++)
            {
                indices_buffer.insert(i % total_poly_vertices + top_indices_offset);
                indices_buffer.insert((i + 1) % total_poly_vertices + bottom_indices_offset);
                indices_buffer.insert(i % total_poly_vertices + bottom_indices_offset);

                indices_buffer.insert(i % total_poly_vertices + top_indices_offset);
                indices_buffer.insert((i + 1) % total_poly_vertices + top_indices_offset);
                indices_buffer.insert((i + 1) % total_poly_vertices + bottom_indices_offset);
            }

            total_vertices += 8;
            total_triangles += 12;
        }
        else
        {

            std::vector<CDT::V2d<double>> vertices;
            CDT::EdgeVec edges;

            for (uint64_t k = 0; k < poly->point_array.count; k++)
            {
                auto point = poly->point_array[k];
                vertices.push_back({point.x, point.y});
            }

            for (uint64_t k = 0; k < poly->point_array.count - 1; k++)
            {
                edges.push_back({(CDT::VertInd)k, (CDT::VertInd)k + 1});
            }
            // close polygon:
            edges.push_back({(CDT::VertInd)poly->point_array.count - 1, (CDT::VertInd)0});

            CDT::Triangulation<double> cdt(
                CDT::detail::defaults::vertexInsertionOrder,
                // CDT::IntersectingConstraintEdges::TryResolve,
                CDT::IntersectingConstraintEdges::NotAllowed,
                CDT::detail::defaults::minDistToConstraintEdge);

            CDT::DuplicatesInfo dup_info;

            dup_info = CDT::RemoveDuplicatesAndRemapEdges(vertices, edges);
            cdt.insertVertices(vertices);
            cdt.insertEdges(edges);
            cdt.eraseOuterTrianglesAndHoles();

            total_triangles += cdt.triangles.size();
            total_vertices += cdt.vertices.size();

            // EXTRUSION

            int total_poly_vertices = cdt.vertices.size();
            // BOTTOM FACES
            int bottom_indices_offset = indices_offset;
            for (int i = 0; i < total_poly_vertices; i++)
            {
                positions_buffer.insert((POSITIONS_TYPE)cdt.vertices[i].x);
                positions_buffer.insert((POSITIONS_TYPE)cdt.vertices[i].y);
                positions_buffer.insert((POSITIONS_TYPE)zmin);
            }
            int orientation = 0;
            for (int i = 0; i < cdt.triangles.size(); i++)
            {
                int d0 = cdt.triangles[i].vertices[0] - cdt.triangles[i].vertices[1];
                int d1 = cdt.triangles[i].vertices[1] - cdt.triangles[i].vertices[2];
                int d2 = cdt.triangles[i].vertices[2] - cdt.triangles[i].vertices[0];
                if (d0 == 1 || d1 == 1 || d2 == 1)
                    orientation = 1;
                else if (d0 == -1 || d1 == -1 || d2 == -1)
                    orientation = -1;

                indices_buffer.insert((INDICES_TYPE)cdt.triangles[i].vertices[2] + indices_offset);
                indices_buffer.insert((INDICES_TYPE)cdt.triangles[i].vertices[1] + indices_offset);
                indices_buffer.insert((INDICES_TYPE)cdt.triangles[i].vertices[0] + indices_offset);
            }
            indices_offset += total_poly_vertices;

            // TOP FACES
            int top_indices_offset = indices_offset;
            for (int i = 0; i < total_poly_vertices; i++)
            {
                positions_buffer.insert((POSITIONS_TYPE)cdt.vertices[i].x);
                positions_buffer.insert((POSITIONS_TYPE)cdt.vertices[i].y);
                positions_buffer.insert((POSITIONS_TYPE)(zmax));
            }
            for (int i = 0; i < cdt.triangles.size(); i++)
            {
                indices_buffer.insert(cdt.triangles[i].vertices[0] + indices_offset);
                indices_buffer.insert(cdt.triangles[i].vertices[1] + indices_offset);
                indices_buffer.insert(cdt.triangles[i].vertices[2] + indices_offset);
            }
            indices_offset += total_poly_vertices;

            // ToDo: We are assuming vertices are sorted like the edges of the polygon. It seems that is the case but might be worth do some extra checking
            // ToDo: I had some issue with SKY130, INV4, LI1 layer, that has a hole (and a duplicated vertex?). The extrusion in the last segments is not closing well.
            // EXTRUDE
            if (dup_info.duplicates.size() > 0)
            {
                // printf("con dpublicados: %d\n", dup_info.duplicates.size());

                for (int i = 0; i < poly->point_array.count; i++)
                {
                    int ai0 = dup_info.mapping[i % poly->point_array.count] + bottom_indices_offset;
                    int ai1 = dup_info.mapping[(i + 1) % poly->point_array.count] + bottom_indices_offset;
                    int ai2 = dup_info.mapping[i % poly->point_array.count] + top_indices_offset;

                    int bi0 = dup_info.mapping[(i + 1) % poly->point_array.count] + bottom_indices_offset;
                    int bi1 = dup_info.mapping[(i + 1) % poly->point_array.count] + top_indices_offset;
                    int bi2 = dup_info.mapping[i % poly->point_array.count] + top_indices_offset;

                    if (orientation == -1)
                    {
                        indices_buffer.insert(ai0);
                        indices_buffer.insert(ai1);
                        indices_buffer.insert(ai2);

                        indices_buffer.insert(bi0);
                        indices_buffer.insert(bi1);
                        indices_buffer.insert(bi2);
                    }
                    else
                    {
                        indices_buffer.insert(ai2);
                        indices_buffer.insert(ai1);
                        indices_buffer.insert(ai0);

                        indices_buffer.insert(bi2);
                        indices_buffer.insert(bi1);
                        indices_buffer.insert(bi0);
                    }
                }
            }
            else
            {
                for (int i = 0; i < total_poly_vertices; i++)
                {
                    if (orientation == -1)
                    {
                        indices_buffer.insert(i % total_poly_vertices + bottom_indices_offset);
                        indices_buffer.insert((i + 1) % total_poly_vertices + bottom_indices_offset);
                        indices_buffer.insert(i % total_poly_vertices + top_indices_offset);

                        indices_buffer.insert((i + 1) % total_poly_vertices + bottom_indices_offset);
                        indices_buffer.insert((i + 1) % total_poly_vertices + top_indices_offset);
                        indices_buffer.insert(i % total_poly_vertices + top_indices_offset);
                    }
                    else
                    {
                        indices_buffer.insert(i % total_poly_vertices + top_indices_offset);
                        indices_buffer.insert((i + 1) % total_poly_vertices + bottom_indices_offset);
                        indices_buffer.insert(i % total_poly_vertices + bottom_indices_offset);

                        indices_buffer.insert(i % total_poly_vertices + top_indices_offset);
                        indices_buffer.insert((i + 1) % total_poly_vertices + top_indices_offset);
                        indices_buffer.insert((i + 1) % total_poly_vertices + bottom_indices_offset);
                    }
                }
            }
        }
    }

    g_triangulation_stats.total_vertices += total_vertices;
    g_triangulation_stats.total_triangles += total_triangles;

    JS_gds_info_log("\t\t\tvertices: %" PRIu64 " triangles: %" PRIu64 "\n", total_vertices, total_triangles);
}

void createLineBuffers(Array<Polygon *> &polygons, GrowBuffer<POSITIONS_TYPE> &positions_buffer, GrowBuffer<INDICES_TYPE> &indices_buffer, float zmin, float zmax)
{
    positions_buffer.reset();
    indices_buffer.reset();

    int indices_offset = 0;

    for (uint64_t j = 0; j < polygons.count; j++)
    {
        auto poly = polygons[j];

        uint64_t points_count = poly->point_array.count;

        // BOTTOM
        for (uint64_t k = 0; k < points_count; k++)
        {
            auto point = poly->point_array[k];
            positions_buffer.insert((POSITIONS_TYPE)point.x);
            positions_buffer.insert((POSITIONS_TYPE)point.y);
            positions_buffer.insert((POSITIONS_TYPE)zmin);

            indices_buffer.insert((INDICES_TYPE)k + indices_offset);
        }
        indices_buffer.insert((INDICES_TYPE)indices_offset);
        // Insert Primitive Restart Index to cut line drawing
        indices_buffer.insert(RESTART_INDEX_VALUE);

        indices_offset += points_count;

        // TOP
        for (uint64_t k = 0; k < points_count; k++)
        {
            auto point = poly->point_array[k];
            positions_buffer.insert((POSITIONS_TYPE)point.x);
            positions_buffer.insert((POSITIONS_TYPE)point.y);
            positions_buffer.insert((POSITIONS_TYPE)zmax);

            indices_buffer.insert((INDICES_TYPE)k + indices_offset);
        }
        indices_buffer.insert((INDICES_TYPE)indices_offset);
        // Insert Primitive Restart Index to cut line drawing
        indices_buffer.insert(RESTART_INDEX_VALUE);

        indices_offset += points_count;

        // Vertical lines
        for (uint64_t k = 0; k < points_count; k++)
        {
            indices_buffer.insert((INDICES_TYPE)k + indices_offset - points_count);
            indices_buffer.insert((INDICES_TYPE)k + indices_offset - 2 * points_count);
            indices_buffer.insert(RESTART_INDEX_VALUE);
        }
    }
}
