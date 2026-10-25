#include <stdio.h>

int target_function(int a, int b) {
    return a * b + 42;
}

int main(void) {
    printf("Result: %d\n", target_function(10, 20));
    return 0;
}
