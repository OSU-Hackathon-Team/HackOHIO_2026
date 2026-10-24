# LibreOffice Repository File Index & Inventory

## 1. System-Wide Module Directory Catalog

This inventory accounts for all top-level repository modules and directories in LibreOffice (149,761 total cataloged entries). Each module is classified by role, file count, and linked directly to its governing architectural specification document.

| Module Directory | Primary Role & Responsibility | Total Entries | Production Files | Governing Specification |
| :--- | :--- | :--- | :--- | :--- |
| **`sal` / `salhelper`** | System Abstraction Layer: OS threads, mutexes, file I/O, memory allocators, pipes, sockets. | 360 | 320 | [Foundation Specification](./modules/foundation.md) |
| **`cppu` / `cppuhelper`** | C++ UNO runtime: reference counted interfaces, weak references, object factories, reflection bridges. | 133 | 125 | [Foundation Specification](./modules/foundation.md) |
| **`binaryurp` / `remotebridges`** | Binary Universal Remote Protocol: marshalling UNO calls over network sockets and local pipes. | 46 | 42 | [Foundation Specification](./modules/foundation.md) |
| **`store` / `registry`** | Structured binary storage engine and type library registries (`.rdb`). | 54 | 48 | [Foundation Specification](./modules/foundation.md) |
| **`configmgr`** | Hierarchical configuration backend managing settings schemas (`.xcs`) and user overrides (`.xcu`). | 77 | 72 | [Foundation Specification](./modules/foundation.md) |
| **`stoc`** | Standard UNO components: runtime core reflection, introspection, type conversion, and loaders. | 108 | 98 | [Foundation Specification](./modules/foundation.md) |
| **`udkapi`** | Fundamental UNO Core IDL definitions (`XInterface`, `XComponent`, `XPropertySet`). | 422 | 422 | [Foundation Specification](./modules/foundation.md) |
| **`basegfx`** | 2D/3D geometry engine: affine transformation matrices (`B2DHomMatrix`), bezier curves, clipping. | 90 | 85 | [Core Utilities Specification](./modules/utilities.md) |
| **`tools`** | Non-UNO fundamental data primitives: DateTime, Color, Fraction, Rectangle, Point, Size. | 98 | 88 | [Core Utilities Specification](./modules/utilities.md) |
| **`comphelper`** | C++ UNO helper classes: property set adapters, listener lifecycle guards, sequence wrappers. | 151 | 142 | [Core Utilities Specification](./modules/utilities.md) |
| **`unotools`** | High-level facades for office configuration, font options, and path settings. | 79 | 74 | [Core Utilities Specification](./modules/utilities.md) |
| **`i18n*`** (`i18npool`, etc.) | Internationalization: BCP-47 language tags, ICU character classification, break iterators, collation. | 544 | 525 | [Core Utilities Specification](./modules/utilities.md) |
| **`ucb` / `ucbhelper`** | Universal Content Broker: URI resolution and streaming for `file://`, `http://`, `vnd.sun.star.*`. | 291 | 270 | [Core Utilities Specification](./modules/utilities.md) |
| **`sax` / `unoxml`** | Fast XML tokenization, streaming SAX events, and DOM tree parser bridges. | 131 | 120 | [Core Utilities Specification](./modules/utilities.md) |
| **`package` / `sot`** | ODF ZIP packaging, manifest validation, stream encryption, and OLE structured storage. | 228 | 210 | [Core Utilities Specification](./modules/utilities.md) |
| **`svl`** | Item pool subsystem (`SfxItemPool`, `SfxItemSet`, `SfxPoolItem`), copy-on-write attribute pools. | 131 | 124 | [Core Utilities Specification](./modules/utilities.md) |
| **`vcl`** | Visual Class Library: window hierarchy, event dispatch loop, Skia/Cairo rendering, font caches. | 3,256 | 2,238 | [Graphics Specification](./modules/graphics.md) |
| **`drawinglayer`** | Declarative 2D/3D drawing primitives, decomposition pipelines, and scene graph traversal. | 217 | 205 | [Graphics Specification](./modules/graphics.md) |
| **`canvas` / `cppcanvas`** | Hardware-accelerated 2D graphics canvas for animations, transitions, and media playback. | 280 | 260 | [Graphics Specification](./modules/graphics.md) |
| **`svtools`** | Extended UI controls: tree list views, rulers, color tables, and address book controls. | 173 | 162 | [Graphics Specification](./modules/graphics.md) |
| **`toolkit`** | UNO AWT bridge translating `com.sun.star.awt.*` interface requests to VCL widgets. | 250 | 235 | [Graphics Specification](./modules/graphics.md) |
| **`fpicker`** | Cross-platform native system file dialog integration (Win32, Cocoa, GTK3, Qt5/6). | 93 | 88 | [Graphics Specification](./modules/graphics.md) |
| **`sfx2`** | Star Framework 2: Document-View-Frame MVC architecture, `SfxDispatcher`, and Undo/Redo stack. | 497 | 445 | [Application Framework Specification](./modules/framework.md) |
| **`framework`** | Modern UNO desktop framework: `LayoutManager`, dockable toolbars, menubars, and statusbars. | 395 | 331 | [Application Framework Specification](./modules/framework.md) |
| **`cui`** | Common User Interface: reusable configuration dialogs (Options, Font styling, Customization). | 523 | 489 | [Application Framework Specification](./modules/framework.md) |
| **`desktop`** | Application startup, CLI argument parser, splash screen, single-instance lock, crash recovery. | 708 | 303 | [Application Framework Specification](./modules/framework.md) |
| **`editeng`** | Multi-line rich text Outliner and EditEngine with inline formatting pools and spell markers. | 158 | 148 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`svx`** | Shared document drawing layer (`SdrModel`, `SdrObject`), 2D/3D shapes, and annotations. | 1,190 | 1,066 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`xmloff`** | OASIS OpenDocument Format (ODF 1.0–1.4) XML import and export serializer engine. | 785 | 700 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`oox`** | Microsoft Office Open XML (OOXML) reader/writer for DOCX, XLSX, PPTX, and DrawingML. | 597 | 409 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`filter`** | Universal format detection framework, MIME type sniffing, and filter resolution. | 791 | 722 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`linguistic*`** | Spell checking, hyphenation, and thesaurus integration (Hunspell and Libhyphen facades). | 97 | 90 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`chart2`** | Modern charting engine: data series mapping, coordinate transformations, 2D/3D charts. | 1,340 | 808 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`forms`** | Database-aware interactive form controls (`com.sun.star.form.*`). | 264 | 248 | [Shared Document Engines Specification](./modules/shared-engines.md) |
| **`sw`** | StarWriter word processor core: `SwDoc`, flat node array `SwNodes`, layout frame tree `SwFrame`. | 8,725 | 2,721 | [Writer Specification](./modules/writer.md) |
| **`writerfilter`** | DOCX and RTF tokenizer and domain mapper targeting Writer's internal UNO model. | 435 | 123 | [Writer Specification](./modules/writer.md) |
| **`sc`** | StarCalc spreadsheet core: `ScDocument`, `ScTable`, column storage `mdds`, multi-threaded recalc. | 5,193 | 2,253 | [Calc Specification](./modules/calc.md) |
| **`formula`** | Formula compiler (`ScCompiler`), grammatical tokenizers, and OpenFormula RPN interpreter. | 42 | 39 | [Calc Specification](./modules/calc.md) |
| **`sd`** | Impress & Draw core: presentation document model (`SdDrawDocument`), slide pages, master pages. | 2,305 | 1,252 | [Impress & Draw Specification](./modules/impress-draw.md) |
| **`slideshow`** | Slide show execution runtime, SMIL animation event queue, and hardware transitions. | 296 | 275 | [Impress & Draw Specification](./modules/impress-draw.md) |
| **`starmath`** | Math formula editor: equation syntax parsing, formula node tree (`SmNode`), visual layout. | 173 | 141 | [Math & Base Specification](./modules/math-base.md) |
| **`dbaccess`** | Base database application: `.odb` container, query designer, table designer, and relations. | 824 | 744 | [Math & Base Specification](./modules/math-base.md) |
| **`connectivity`** | SDBC database drivers: embedded Firebird, PostgreSQL, MySQL/MariaDB, JDBC, ODBC, CSV. | 804 | 765 | [Math & Base Specification](./modules/math-base.md) |
| **`reportdesign`** | Visual band-oriented database report designer and generator engine. | 265 | 250 | [Math & Base Specification](./modules/math-base.md) |
| **`basic` / `basctl`** | StarBasic compiler, bytecode interpreter, runtime functions, and interactive IDE debugger. | 582 | 260 | [Scripting & Embedding Specification](./modules/scripting-lokit.md) |
| **`pyuno`** | Python-to-UNO runtime bridge providing dynamic type conversion and script execution. | 80 | 75 | [Scripting & Embedding Specification](./modules/scripting-lokit.md) |
| **`libreofficekit`** | Direct C API for headless rendering, tiled viewports, and Collabora Online web integration. | 48 | 44 | [Scripting & Embedding Specification](./modules/scripting-lokit.md) |
| **`vbahelper`** | Microsoft Office VBA scripting compatibility layer (`ActiveWorkbook`, `Range`, `Cells`). | 87 | 82 | [Scripting & Embedding Specification](./modules/scripting-lokit.md) |

---

## 2. Key Production Source File Inventory

The following index categorizes critical production source files across the repository, summarizing their conceptual responsibility and linking to the relevant behavioral specification:

### Foundation & Platform Abstraction Layer
- `sal/osl/unx/thread.cxx` / `sal/osl/w32/thread.cxx`: Implements OS thread creation, priority mapping, and thread-local storage. -> [modules/foundation.md#2-component-architecture--data-structures](./modules/foundation.md)
- `sal/osl/all/mutex.cxx`: Implements recursive OS mutex handles and atomic test-and-set guards. -> [modules/foundation.md#2-component-architecture--data-structures](./modules/foundation.md)
- `sal/osl/unx/file.cxx` / `sal/osl/w32/file.cxx`: Implements RFC-2396 URI-based native file streaming and directory traversal. -> [modules/foundation.md#2-component-architecture--data-structures](./modules/foundation.md)
- `cppu/source/uno/any.cxx`: Implements `uno::Any` generic polymorphic type container and reflection metadata binding. -> [modules/foundation.md#3-behavioral-rules--algorithms](./modules/foundation.md)
- `cppuhelper/source/weak.cxx`: Implements `OWeakObject` intrusive atomic reference counting and weak connection notifications. -> [modules/foundation.md#3-behavioral-rules--algorithms](./modules/foundation.md)
- `binaryurp/source/bridge.cxx`: Implements binary frame serialization and socket marshaling for remote UNO bridges. -> [modules/foundation.md#1-overview--purpose](./modules/foundation.md)
- `configmgr/source/configurationprovider.cxx`: Implements layered configuration resolution merging schema defaults with user XML profiles. -> [modules/foundation.md#32-configuration-resolution-hierarchy](./modules/foundation.md)

### Core Utilities, Geometry & Internationalization Layer
- `basegfx/matrix/b2dhommatrix.cxx`: Implements $3 \times 3$ affine transformation matrix multiplication, rotation, scaling, and inversion. -> [modules/utilities.md#2-component-architecture--data-structures](./modules/utilities.md)
- `basegfx/polygon/b2dpolygon.cxx`: Implements 2D poly-bezier curve subdivision and polygon clipping routines. -> [modules/utilities.md#2-component-architecture--data-structures](./modules/utilities.md)
- `comphelper/source/property/propertysethelper.cxx`: Implements fast integer-indexed property lookup and change broadcasts for UNO components. -> [modules/utilities.md#1-overview--purpose](./modules/utilities.md)
- `i18npool/source/breakiterator/breakiterator_unicode.cxx`: Implements Unicode word, sentence, and script boundary analysis using ICU break iterators. -> [modules/utilities.md#4-internationalization-i18n-rules--break-iterator](./modules/utilities.md)
- `ucb/source/core/ucb.cxx`: Coordinates URL scheme routing and dispatches content commands to registered provider plugins. -> [modules/utilities.md#32-ucb-content-resolution-and-streaming](./modules/utilities.md)
- `package/source/zippackage/ZipPackage.cxx`: Implements ZIP container streaming, manifest encryption, and SHA-256 package verification. -> [modules/utilities.md#1-overview--purpose](./modules/utilities.md)
- `svl/source/items/itempool.cxx`: Manages deduplicated, copy-on-write formatting attribute pools (`SfxItemPool`). -> [modules/utilities.md#33-attribute-pooling--copy-on-write](./modules/utilities.md)

### Visual Class Library & Graphical Subsystems Layer
- `vcl/source/app/svapp.cxx`: Implements the central application event loop, timer scheduling, and idle job dispatcher. -> [modules/graphics.md#31-vcl-event-loop--window-message-dispatch](./modules/graphics.md)
- `vcl/source/window/window.cxx`: Implements the hierarchical window tree, coordinate clipping, focus handling, and input event routing. -> [modules/graphics.md#2-component-architecture--data-structures](./modules/graphics.md)
- `vcl/source/outdev/outdev.cxx`: Implements logical coordinate mapping (`MapMode`), font metric selection, and primitive blitting. -> [modules/graphics.md#4-state-transitions--coordinate-spaces](./modules/graphics.md)
- `vcl/skia/gdiimpl.cxx`: Bridges VCL rendering requests to GPU-accelerated Skia Vulkan/Metal/DirectX surfaces. -> [modules/graphics.md#5-error-handling--edge-cases](./modules/graphics.md)
- `drawinglayer/source/processor2d/baseprocessor2d.cxx`: Executes recursive primitive decomposition down to atomic rasterizable primitives. -> [modules/graphics.md#33-declarative-primitive-decomposition](./modules/graphics.md)

### Application Framework & Document Shell Layer
- `sfx2/source/doc/objstor.cxx`: Manages document persistence, dirty state tracking, and storage medium flushes. -> [modules/framework.md#2-component-architecture--data-structures](./modules/framework.md)
- `sfx2/source/control/dispatch.cxx`: Implements slot pool dispatching across the active shell stack. -> [modules/framework.md#31-sfxdispatcher-slot-routing-algorithm](./modules/framework.md)
- `sfx2/source/appl/undomanager.cxx`: Implements multi-level undo/redo action tracking and save mark validation. -> [modules/framework.md#2-component-architecture--data-structures](./modules/framework.md)
- `framework/source/layoutmanager/layoutmanager.cxx`: Manages dynamic docking, floating bounds, and visibility for menus, sidebars, and status bars. -> [modules/framework.md#32-layoutmanager-docking-calculation](./modules/framework.md)
- `desktop/source/app/app.cxx`: Coordinates process bootstrap, single-instance socket checks, command-line arguments, and crash recovery. -> [modules/framework.md#4-desktop-startup--command-line-processing](./modules/framework.md)

### Shared Document Engines Layer
- `editeng/source/editeng/editeng.cxx`: Implements rich-text paragraph layout, inline character formatting spans, and cursor selection ranges. -> [modules/shared-engines.md#2-component-architecture--data-structures](./modules/shared-engines.md)
- `svx/source/svdraw/svdmodel.cxx`: Manages vector shape model hierarchies, z-order sorting, and drawing layer attachments. -> [modules/shared-engines.md#2-component-architecture--data-structures](./modules/shared-engines.md)
- `xmloff/source/core/xmlimp.cxx` / `xmlexp.cxx`: Implements ODF XML streaming ingestion and emission for document content and styles. -> [modules/shared-engines.md#32-odf-streaming-serialization-pipeline](./modules/shared-engines.md)
- `filter/source/config/cache/typedetection.cxx`: Executes magic byte pattern matching and MIME type sniffing to identify document formats. -> [modules/shared-engines.md#31-content-based-format-sniffing-algorithm](./modules/shared-engines.md)
- `linguistic/source/spellchk.cxx`: Dispatches asynchronous background spell-checking passes to Hunspell engine adapters. -> [modules/shared-engines.md#4-linguistic-verification--spell-checking-pipeline](./modules/shared-engines.md)

### Writer (Word Processor) Subsystem
- `sw/source/core/doc/doc.cxx`: Central controller for the Writer document model (`SwDoc`), owning document content and layout managers. -> [modules/writer.md#2-component-architecture--data-structures](./modules/writer.md)
- `sw/source/core/docnode/nodes.cxx`: Implements the flat linear array (`SwNodes`) storing document text nodes, section boundaries, and tables. -> [modules/writer.md#2-component-architecture--data-structures](./modules/writer.md)
- `sw/source/core/txtnode/ndtxt.cxx`: Manages paragraph text strings, inline attribute hint arrays (`SwpHintsArray`), and outline levels. -> [modules/writer.md#32-inline-hint-merging--portion-creation](./modules/writer.md)
- `sw/source/core/layout/flowfrm.cxx`: Coordinates paragraph flow, page break splits, and widow/orphan constraints across pages. -> [modules/writer.md#31-paragraph-flow-and-page-splitting-algorithm](./modules/writer.md)
- `sw/source/core/layout/pagefrm.cxx`: Constructs and formats physical page frames, managing headers, footers, columns, and body areas. -> [modules/writer.md#4-state-transitions--layout-tree-synchronization](./modules/writer.md)
- `writerfilter/source/dmapper/DomainMapper.cxx`: Maps OOXML WordprocessingML and RTF tokens to Writer's internal UNO property models. -> [modules/writer.md#1-overview--purpose](./modules/writer.md)

### Calc (Spreadsheet) Subsystem
- `sc/source/core/data/document.cxx`: Coordinates multi-sheet grid storage, calculation configurations, and formula tree evaluations. -> [modules/calc.md#2-component-architecture--data-structures](./modules/calc.md)
- `sc/source/core/data/column.cxx`: Implements column-oriented contiguous block storage (`mdds`) for numbers, strings, and formula cells. -> [modules/calc.md#2-component-architecture--data-structures](./modules/calc.md)
- `sc/source/core/tool/compiler.cxx`: Compiles spreadsheet formula strings into Reverse Polish Notation (RPN) token arrays. -> [modules/calc.md#1-overview--purpose](./modules/calc.md)
- `sc/source/core/tool/interpre.cxx`: Stack-based virtual machine executing formula RPN bytecodes and mathematical functions. -> [modules/calc.md#31-formula-stack-machine-evaluation](./modules/calc.md)
- `sc/source/core/data/formulacell.cxx`: Coordinates formula cell dependency DAG tracking, dirty flag cascading, and calculation group grouping. -> [modules/calc.md#32-dependency-dag-dirty-propagation](./modules/calc.md)

### Impress & Draw Subsystem
- `sd/source/core/drawdoc.cxx`: Presentation document controller managing slides, master templates, and custom presentation sequences. -> [modules/impress-draw.md#2-component-architecture--data-structures](./modules/impress-draw.md)
- `sd/source/core/sdpage.cxx`: Implements individual slide canvases, master page inheritance, and shape hierarchies. -> [modules/impress-draw.md#31-master-page-style--attribute-inheritance](./modules/impress-draw.md)
- `slideshow/source/engine/slideshowimpl.cxx`: Orchestrates fullscreen presentation rendering, display surfaces, and view controllers. -> [modules/impress-draw.md#4-state-transitions--presentation-flow](./modules/impress-draw.md)
- `slideshow/source/engine/eventqueue.cxx`: Time-based animation event scheduler driving property interpolation and transition effects. -> [modules/impress-draw.md#32-slide-show-event-queue--time-tick-scheduling](./modules/impress-draw.md)

### Math & Base Subsystem
- `starmath/source/parse.cxx`: Parses equation text into a typographical syntax tree (`SmNode`). -> [modules/math-base.md#2-component-architecture--data-structures](./modules/math-base.md)
- `starmath/source/view.cxx`: Formats fraction bars, radical roots, and matrices, calculating visual bounding boxes and typographical baselines. -> [modules/math-base.md#31-mathematical-layout--baseline-alignment](./modules/math-base.md)
- `dbaccess/source/core/dataaccess/Model.cxx`: Manages `.odb` container packages, embedded database engine lifecycle, and query definitions. -> [modules/math-base.md#4-state-transitions--embedded-database-lifecycle](./modules/math-base.md)
- `connectivity/source/manager/vclman.cxx`: SDBC connection manager matching connection URLs to registered database driver components. -> [modules/math-base.md#32-sdbc-connection-resolution--dispatch](./modules/math-base.md)

### Scripting & Embedding Subsystems
- `basic/source/comp/parser.cxx`: Compiles StarBasic source code into P-code bytecode blocks. -> [modules/scripting-lokit.md#2-component-architecture--data-structures](./modules/scripting-lokit.md)
- `basic/source/runtime/runtime.cxx`: P-code interpreter executing StarBasic statements, variable watch registers, and error handlers. -> [modules/scripting-lokit.md#1-overview--purpose](./modules/scripting-lokit.md)
- `pyuno/source/module/pyuno_runtime.cxx`: Implements bidirectional marshaling between Python PyObject types and UNO `Any` values. -> [modules/scripting-lokit.md#32-pyuno-dynamic-type-conversion](./modules/scripting-lokit.md)
- `libreofficekit/source/gtk/lokdocview.c`: Implements the C ABI entry points (`paintTile`, `postMouseEvent`, `createView`) for external hosts. -> [modules/scripting-lokit.md#31-libreofficekit-tiled-rendering-pipeline](./modules/scripting-lokit.md)

---

## 3. Non-Production Directory Inventory

Directories outside the production compilation path are categorized below:

| Directory | Classification | Content Description | Handling in Specification |
| :--- | :--- | :--- | :--- |
| **`icon-themes/`** | Visual Assets | 89,993 SVG and PNG icon files for desktop theme variants (Colibre, Breeze, Sifr, Elementary). | Excluded from behavioral logic; categorized as UI static asset bundle. |
| **`extras/`** | Document Assets | 4,994 document templates, color palettes (`.soc`), gallery clipart, and auto-text entries. | Excluded from behavioral logic; categorized as content templates. |
| **`dictionaries/`** | Content Submodule | External Git submodule containing localized Hunspell dictionaries and hyphenation rule sets. | Covered under linguistic engine integration facades. |
| **`helpcontent2/`** | Documentation | Localized XML/HTML help pages and user documentation manuals. | Excluded from runtime behavioral specification. |
| **`external/`** | Vendored Dependencies | 1,419 build configuration files, patches, and tarball URLs for external libraries (ICU, Skia, HarfBuzz, Zlib). | Documented as external library boundaries in [dependencies.md](./dependencies.md). |
| **`qadevOOo/`** | Test Harness | 1,899 Java-based automated UNO interface compatibility tests. | Excluded; categorized as QA validation harness. |
| **`test/` / `uitest/`** | Test Infrastructure | Integration test helpers, python UI automation scripts, and test document fixtures. | Excluded; categorized as regression test infrastructure. |
| **`solenv/` / `soltools/`** | Build Engineering | GNU Make gbuild build system definitions, compilation flags, and cross-compilation helpers. | Excluded; categorized as developer build tooling. |
| **`compilerplugins/`** | Clang Tooling | Custom Clang AST plugins enforcing internal coding conventions and memory safety checks during compilation. | Excluded; categorized as static analysis tooling. |
| **`codemaker/` / `idlc`** | IDL Compilers | Compiles UNO IDL (`.idl`) into binary type libraries (`.rdb`) and C++ header bindings. | Documented as type library compiler in [architecture.md](./architecture.md). |
| **`sysui/` / `scp2`** | Packaging & Installers | OS desktop integration scripts (MIME types, desktop icons) and MSI/RPM/DEB packaging manifests. | Excluded; categorized as system deployment packaging. |
