- finish product determination logic
- finish handle generation logic (maybe needed for item above?)
- finish spec parsing (qpl, meets specs)
- finish tag parsing/writing logic
- need to add size resolution logic (likely by type/manufacturer)

other nice to have:

- check for "reactivate" SKUs...those in accountmate input but set to Archived in shopify

next, there are several fields where accountmate values must map to one or more shopify custom metaobjects. we need to resolve the accountmate-provided value to the handle for the custom shopify metaobject:

QPL
Meets Specs
Size
Color

Each of these has some idiosyncrasies that make it different from the others.

Let's start with QPL and Meets Specs, since these share a lot of mapping code. these are semicolon-delimited strings from AccountMate. both QPL and Meets Specs are product-level metafields in shoopify of type list of metaobjects. not all of the accountmate-provided values can or should have an entry in Shopify. the good news is that the legacy implementation is entirely correct for these - let's port over whatever is there to implement our getSpecs function for transforming these.

next up: size

if SKU is VV-P-236 CAN 1-LB
set Size to "1-lb Can"

if SKU is SCOTCH-BR7447
set Size to "20-count Box"

if unit of measure is RL, extract roll size from "Short description", eg for
3M™ High Performance Masking Tape 232, Tan, 24 mm x 55 m (1 in.) 6.3 mil, 36 Roll/Case
it should be
24 mm x 55 m (1 in.)
and for
3M™ High Performance Masking Tape 232, Tan, 48 mm x 55 m (2 in.), 6.3 mil, 24 Roll/Case
it should be
48 mm x 55 m (2 in.)

for all other products, apply this mapping using unit of measure from AccountMate
1-GL KIT -> "1 Gallon Kit"
1-QT KIT -> "1 Quart Kit"
1.25-GL KT -> "1.25 Gallon Kit"
1.5-GL KT -> "1.5 Gallon Kit"
1.5 -GL KT -> "1.5 Gallon Kit"
2-GL KIT -> "2 Gallon Kit"
2-QT KIT -> "2 Quart Kit"
2-OZ KIT -> 2oz Touch-up Kit"
4-GL KIT -> "4 Gallon Kit"
5-GL KIT -> "5 Gallon Kit"
6-OZ KIT -> "6oz Touch-up Kit"
PINT KIT -> "Pint Kit"
QRT -> "Quart"
QUART KIT -> "Quart Kit"
GALLON -> "Gallon"

    next, color. let's only populate this for Henzten products, and only those where accountmate's "Color" column is set. the shopify value should correspond to the handle of a built-in shopify color pattern. here is the mapping to use:

    TAN -> "shopify--color-pattern.beigi"
    WHITE -> "shopify--color-pattern.white"
    GREEN -> "shopify--color-pattern.green"
    SILVER -> "shopify--color-pattern.silver"
    BLUE -> "shopify--color-pattern.blue"
    CLEAR -> "shopify--color-pattern.clear"
    BLACK -> "shopify--color-pattern.black"
    GRAY -> "shopify--color-pattern.gray"
    YELLOW -> "shopify--color-pattern.yellow"
    RED -> "shopify--color-pattern.red"
    BROWN -> "shopify--color-pattern.brown"
    VIOLET -> "shopify--color-pattern.navy"
    AMBER -> "shopify--color-pattern.red"
    DARK GREEN -> "shopify--color-pattern.green"
    ORANGE -> "shopify--color-pattern.orange"
    MAROON -> "shopify--color-pattern.red"

that worked, thank you. now, for new products, few changes to output fields.

1.  handle - we need to finally implement the handle generation mapping. they should be built using the pattern:

[shopify-encoded manufacturer]-[manufacturer part number]-[terse 2-5 description]-[optional mil spec]

for reference while implementing the mapping logic, you can look at any of the trusted+\_sync csv files under the "runs" folder to see what handles look like for different products and different descriptions.

2. title - the goal is to update accountmate such that titles stored there are all appropriate for the user-facing website, but we're not there yet. so, for now, and per seo best practices, let's build the field mapping function to produce titles as follows:

[manufacturer] [manufacturer part number] [short description] ([specs per title/short description from accountmate]) - [color per short description from accountmate]

please see the file i've added @Products.csv for examples of existing titles for help with developing the mapping logic.

if you think invoking AI would help either for handle or title generation rather than a complicated generator function, let's discuss.
