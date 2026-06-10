// Test-only C++ harness around Technica's `vector_blf` library, used as
// a black-box oracle for `cannet-blf`'s own BLF implementation
// (ADR 0009 §"Test coverage strategy" source 4). Built by
// `scripts/build-vector-blf-oracle.sh` against a vector_blf clone
// pinned in the build script; never links into cannet's runtime binary.
//
// Output is TSV on stdout so Rust tests can parse it without an
// external dependency. Errors go to stderr; non-zero exit on any
// failure.
//
// Subcommands:
//
//   list <path>
//     Read every object in <path> and emit one TSV row per object:
//       <typeId>\t<typeName>\t<timestampNs>
//     Timestamps are normalised to nanoseconds using each object's
//     objectFlags (0 = 10 us granularity, 1 = 1 ns granularity per
//     Vector's spec). Header rows (FileStatistics, EndOfFile) are
//     emitted as typeId 0xFFFF / typeId 0xFFFE so the count round-trips
//     cleanly.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

#include <Vector/BLF.h>

namespace {

const char* type_name(Vector::BLF::ObjectType id) {
    using T = Vector::BLF::ObjectType;
    switch (id) {
        case T::UNKNOWN:               return "UNKNOWN";
        case T::CAN_MESSAGE:           return "CAN_MESSAGE";
        case T::CAN_ERROR:             return "CAN_ERROR";
        case T::CAN_OVERLOAD:          return "CAN_OVERLOAD";
        case T::CAN_STATISTIC:         return "CAN_STATISTIC";
        case T::APP_TRIGGER:           return "APP_TRIGGER";
        case T::ENV_INTEGER:           return "ENV_INTEGER";
        case T::ENV_DOUBLE:            return "ENV_DOUBLE";
        case T::ENV_STRING:            return "ENV_STRING";
        case T::ENV_DATA:              return "ENV_DATA";
        case T::LOG_CONTAINER:         return "LOG_CONTAINER";
        case T::APP_TEXT:              return "APP_TEXT";
        case T::CAN_ERROR_EXT:         return "CAN_ERROR_EXT";
        case T::CAN_DRIVER_ERROR_EXT:  return "CAN_DRIVER_ERROR_EXT";
        case T::CAN_MESSAGE2:          return "CAN_MESSAGE2";
        case T::GLOBAL_MARKER:         return "GLOBAL_MARKER";
        case T::CAN_FD_MESSAGE:        return "CAN_FD_MESSAGE";
        case T::CAN_FD_MESSAGE_64:     return "CAN_FD_MESSAGE_64";
        case T::CAN_FD_ERROR_64:       return "CAN_FD_ERROR_64";
        case T::EVENT_COMMENT:         return "EVENT_COMMENT";
        case T::DATA_LOST_BEGIN:       return "DATA_LOST_BEGIN";
        case T::DATA_LOST_END:         return "DATA_LOST_END";
        case T::REALTIMECLOCK:         return "REALTIMECLOCK";
        default:                       return "OTHER";
    }
}

uint64_t to_nanos(uint32_t object_flags, uint64_t object_timestamp) {
    // Per binlog_objects.h: objectFlags bit 0 selects the timestamp
    // granularity. 0 = 10 microseconds per tick (default in older BLFs),
    // 1 = 1 nanosecond per tick (modern captures). Anything else is
    // a malformed object — we surface it as 0 and let the test layer
    // assert.
    constexpr uint32_t TIME_TEN_MICS = 1;
    constexpr uint32_t TIME_ONE_NANS = 2;
    switch (object_flags) {
        case TIME_TEN_MICS: return object_timestamp * 10'000;
        case TIME_ONE_NANS: return object_timestamp;
        default:            return object_timestamp;
    }
}

int cmd_list(const std::string& path) {
    Vector::BLF::File file;
    file.open(path.c_str(), std::ios_base::in);
    if (!file.is_open()) {
        std::cerr << "oracle: cannot open " << path << "\n";
        return 2;
    }

    while (file.good() && !file.eof()) {
        Vector::BLF::ObjectHeaderBase* obj = file.read();
        if (obj == nullptr) {
            break;
        }
        uint64_t timestamp_ns = 0;
        // ObjectHeader and ObjectHeader2 both inherit from
        // ObjectHeaderBase but only ObjectHeader carries
        // objectTimeStamp directly; cast based on headerVersion.
        if (auto* h1 = dynamic_cast<Vector::BLF::ObjectHeader*>(obj)) {
            timestamp_ns = to_nanos(h1->objectFlags, h1->objectTimeStamp);
        } else if (auto* h2 = dynamic_cast<Vector::BLF::ObjectHeader2*>(obj)) {
            timestamp_ns = to_nanos(h2->objectFlags, h2->objectTimeStamp);
        }
        std::cout << static_cast<uint32_t>(obj->objectType) << '\t'
                  << type_name(obj->objectType) << '\t'
                  << timestamp_ns << '\n';
        delete obj;
    }

    file.close();
    return 0;
}

void usage() {
    std::cerr <<
        "usage: vector-blf-oracle-harness <subcommand> [args...]\n"
        "subcommands:\n"
        "  list <path>   list objects in a BLF as TSV (type, name, timestamp_ns)\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage();
        return 64;
    }
    std::string sub = argv[1];
    if (sub == "list") {
        if (argc != 3) { usage(); return 64; }
        return cmd_list(argv[2]);
    }
    usage();
    return 64;
}
