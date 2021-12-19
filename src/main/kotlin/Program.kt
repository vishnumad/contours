import processing.core.PApplet
import kotlin.math.abs

const val spacing = 4
const val noiseScale = 0.011f
const val landThreshold = 0.55
const val isolineInc = 0.012

const val verticalBias = 0f
const val elevationMultiplier = 250f

const val bgColor = "fef0d9"
const val outlineColor = "c0526e"
const val waterColor = "00b4d8"

class Program : PApplet() {
    private val w = 2000
    private val h = 2000

    private val cols = w / spacing + 1
    private val rows = h / spacing + 1

    private var seed = System.currentTimeMillis()
    private var simplex = OpenSimplex2S(seed)
    private val elevationSamples = Array(cols) { DoubleArray(rows) }

    private var screenshot = false

    override fun settings() {
        size(1000, 1000, P3D)
        smooth(10)
    }

    override fun setup() {
        ortho(-width / 2f, width / 2f, -height / 2f, height / 2f, -1f * w, 1f * w)
    }

    override fun draw() {
        background(bgColor)

        translate(width / 2f, height / 2f)
        rotateX(radians(65f))
        rotateZ(radians(45f))

        var maxElevation = 0.0

        // Init elevation sample grid
        for (_x in 0 until cols) {
            for (_y in 0 until rows) {
                val x = _x.toDouble()
                val y = _y.toDouble()
                val e = elevation(x, y) +
                        0.5 * elevation(2 * x, 2 * y) +
                        0.25 * elevation(4 * x, 4 * y) +
                        0.125 * elevation(8 * x, 8 * y)

                val elevation = e / (1 + 0.5 + 0.25 + 0.125)
                elevationSamples[_y][_x] = elevation

                if (elevation > maxElevation) {
                    maxElevation = elevation
                }
            }
        }

        // Draw water
        stroke(waterColor)
        strokeWeight(2f)
        for (x in 0 until cols step 2) {
            for (y in 0 until rows step 2) {
                val elevation = elevationSamples[y][x]
                if (elevation < landThreshold) {
                    point(
                        x.toFloat() * spacing - width / 2f,
                        y.toFloat() * spacing - height / 2f,
                        landThreshold.toFloat() * elevationMultiplier + verticalBias
                    )
                }
            }
        }

        // Draw contours
        stroke(outlineColor)
        strokeWeight(1.5f)
        var threshold = landThreshold
        while (threshold <= maxElevation) {
            drawContours(threshold)
            threshold += isolineInc
        }

        if (screenshot) {
            saveFrame("output/img_${seed}.png")
            screenshot = false
        }

        noLoop()
    }

    private fun elevation(x: Double, y: Double): Double {
        return simplex(x * noiseScale, y * noiseScale)
    }

    private fun simplex(x: Double, y: Double): Double {
        return map(simplex.noise2(x, y).toFloat(), -1f, 1f, 0f, 1f).toDouble()
    }

    private fun mix(left: Float, right: Float, x: Float): Float {
        return left * (1.0f - x) + right * x
    }

    private fun drawContours(threshold: Double) {
        val contour = createShape()
        contour.beginShape(LINES)

        for (_x in 0 until cols - 1) {
            for (_y in 0 until rows - 1) {
                // NW           NE
                //   ┌─────────┐
                //   │ a     b │
                //   │         │
                //   │ d     c │
                //   └─────────┘
                // SW           SE

                val x = (_x * spacing).toFloat() - width / 2f
                val y = (_y * spacing).toFloat() - height / 2f

                val nw = elevationSamples[_y][_x]
                val ne = elevationSamples[_y][_x + 1]
                val sw = elevationSamples[_y + 1][_x]
                val se = elevationSamples[_y + 1][_x + 1]

                val percentAB = ((threshold - nw) / (ne - nw)).toFloat() // percent between a and b
                val ax = mix(x, x + spacing, percentAB)
                val ay = y

                val percentBC = ((threshold - ne) / (se - ne)).toFloat() // percent between b and c
                val bx = x + spacing
                val by = mix(y, y + spacing, percentBC)

                val percentCD = ((threshold - sw) / (se - sw)).toFloat() // percent between c and d
                val cx = mix(x, x + spacing, percentCD)
                val cy = y + spacing

                val percentDA = ((threshold - nw) / (sw - nw)).toFloat() // percent between d and a
                val dx = x
                val dy = mix(y, y + spacing, percentDA)

                val orientation = binaryToDecimal(
                    a = nw,
                    b = ne,
                    c = se,
                    d = sw,
                    threshold = threshold
                )

                val contourZ = (threshold * elevationMultiplier + verticalBias).toFloat()
                val fillZ = contourZ - 1.5f

                when (orientation) {
                    0 -> {
                        // empty, don't fill
                    }
                    1 -> {
                        fillShape {
                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)
                        }

                        contour.vertex(cx, cy, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    2 -> {
                        fillShape {
                            vertex(bx, by, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                        }

                        contour.vertex(bx, by, contourZ)
                        contour.vertex(cx, cy, contourZ)
                    }
                    3 -> {
                        fillShape {
                            vertex(bx, by, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                        }

                        contour.vertex(bx, by, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    4 -> {
                        fillShape {
                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(bx, by, contourZ)
                    }
                    5 -> {
                        fillShape {
                            vertex(x + spacing, y, fillZ)
                            vertex(ax, ay, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(bx, by, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(dx, dy, contourZ)
                        contour.vertex(bx, by, contourZ)
                        contour.vertex(cx, cy, contourZ)
                    }
                    6 -> {
                        fillShape {
                            vertex(ax, ay, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(cx, cy, contourZ)
                    }
                    7 -> {
                        fillShape {
                            vertex(ax, ay, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    8 -> {
                        fillShape {
                            vertex(ax, ay, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    9 -> {
                        fillShape {
                            vertex(ax, ay, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(x, y, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(cx, cy, contourZ)
                    }
                    10 -> {
                        fillShape {
                            vertex(x, y, fillZ)
                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(bx, by, contourZ)
                        contour.vertex(cx, cy, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    11 -> {
                        fillShape {
                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(x, y, fillZ)
                        }

                        contour.vertex(ax, ay, contourZ)
                        contour.vertex(bx, by, contourZ)
                    }
                    12 -> {
                        fillShape {
                            vertex(bx, by, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        contour.vertex(bx, by, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    13 -> {
                        fillShape {
                            vertex(bx, by, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(x, y, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        contour.vertex(bx, by, contourZ)
                        contour.vertex(cx, cy, contourZ)
                    }
                    14 -> {
                        fillShape {
                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y, fillZ)
                            vertex(x + spacing, y, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                        }

                        contour.vertex(cx, cy, contourZ)
                        contour.vertex(dx, dy, contourZ)
                    }
                    15 -> {
                        // Saves some unnecessary draws
                        if (abs(threshold - nw) < 0.03) {
                            fillShape {
                                vertex(x, y, fillZ)
                                vertex(x + spacing, y, fillZ)
                                vertex(x + spacing, y + spacing, fillZ)
                                vertex(x, y + spacing, fillZ)
                            }
                        }
                    }
                }
            }
        }

        contour.endShape(CLOSE)
        shape(contour)
    }

    private fun binaryToDecimal(a: Double, b: Double, c: Double, d: Double, threshold: Double): Int {
        val aBit = if (a > threshold) 8 else 0
        val bBit = if (b > threshold) 4 else 0
        val cBit = if (c > threshold) 2 else 0
        val dBit = if (d > threshold) 1 else 0

        return aBit + bBit + cBit + dBit
    }

    private inline fun fillShape(vertices: () -> Unit) {
        push()
        noStroke()
        fill(bgColor)
        beginShape()
        vertices()
        endShape(CLOSE)
        pop()
    }

    override fun keyPressed() {
        when (key) {
            'r' -> {
                simplex = OpenSimplex2S(System.currentTimeMillis())
                redraw()
            }
            's' -> {
                screenshot = true
                redraw()
            }
        }
    }
}

fun main() {
    PApplet.main("Program")
}