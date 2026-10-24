#include <stdio.h>

extern int project_adjust(int value);

int main(int argc, char **argv) {
    int value = project_adjust(argc > 1 ? -3 : 5);
    printf("%d\n", value);
    return value == 12 ? 0 : 1;
}
