import processing.core.PApplet
import processing.core.PShape

fun PApplet.fill(hex: String) {
    val colorInt = PApplet.unhex(hex)
    fill(red(colorInt), green(colorInt), blue(colorInt))
}

fun PApplet.fill(shape: PShape, hex: String) {
    val colorInt = PApplet.unhex(hex)
    shape.fill(red(colorInt), green(colorInt), blue(colorInt))
}

fun PApplet.background(hex: String) {
    val colorInt = PApplet.unhex(hex)
    background(red(colorInt), green(colorInt), blue(colorInt))
}

fun PApplet.stroke(hex: String) {
    val colorInt = PApplet.unhex(hex)
    stroke(red(colorInt), green(colorInt), blue(colorInt))
}