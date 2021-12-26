import processing.core.PApplet
import kotlin.math.abs

const val spacing = 4
const val noiseScale = 0.0075f
const val landThreshold = 0.45
const val isolineInc = 0.012

const val verticalBias = 0f
const val elevationMultiplier = 200f

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

        // Position camera
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
        return simplex(x * noiseScale + 150, y * noiseScale + 150)
//        return noise((x * noiseScale + 150).toFloat(), (y * noiseScale + 150).toFloat()).toDouble()
    }

    private fun simplex(x: Double, y: Double): Double {
        return map(simplex.noise2(x, y).toFloat(), -1f, 1f, 0f, 1f).toDouble()
    }

    private fun mix(left: Float, right: Float, x: Float): Float {
        return left * (1.0f - x) + right * x
    }

    // Draw contours using marching squares
    // https://en.wikipedia.org/wiki/Marching_squares
    private fun drawContours(threshold: Double) {
        val contourShape = createShape()
        contourShape.beginShape(LINES)

        val fillShape = createShape()
        fillShape.beginShape(TRIANGLES)
        fillShape.noStroke()
        fill(fillShape, bgColor)

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

                // z axis values for vertices
                val contourZ = (threshold * elevationMultiplier + verticalBias).toFloat()
                val fillZ = contourZ - 1.5f

                when (binaryToDecimal(a = nw, b = ne, c = se, d = sw, threshold = threshold)) {
                    0 -> {
                        // empty, don't fill
                    }
                    1 -> {
                        with(fillShape) {
                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)
                        }

                        with(contourShape) {
                            vertex(cx, cy, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    2 -> {
                        with(fillShape) {
                            vertex(bx, by, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                        }

                        with(contourShape) {
                            vertex(bx, by, contourZ)
                            vertex(cx, cy, contourZ)
                        }
                    }
                    3 -> {
                        with(fillShape) {
                            vertex(bx, by, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)

                            vertex(x, y + spacing, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                            vertex(bx, by, fillZ)
                        }

                        with(contourShape) {
                            vertex(bx, by, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    4 -> {
                        with(fillShape) {
                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(bx, by, contourZ)
                        }
                    }
                    5 -> {
                        with(fillShape) {
                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(x + spacing, y, fillZ)

                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)

                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(ax, ay, fillZ)

                            vertex(cx, cy, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(ax, ay, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(dx, dy, contourZ)
                            vertex(bx, by, contourZ)
                            vertex(cx, cy, contourZ)
                        }
                    }
                    6 -> {
                        with(fillShape) {
                            vertex(ax, ay, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)

                            vertex(ax, ay, fillZ)
                            vertex(x + spacing, y, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(cx, cy, contourZ)
                        }
                    }
                    7 -> {
                        with(fillShape) {
                            vertex(ax, ay, fillZ)
                            vertex(x + spacing, y, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)

                            vertex(dx, dy, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)

                            vertex(ax, ay, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    8 -> {
                        with(fillShape) {
                            vertex(ax, ay, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x, y, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    9 -> {
                        with(fillShape) {
                            vertex(x, y, fillZ)
                            vertex(ax, ay, fillZ)
                            vertex(cx, cy, fillZ)

                            vertex(x, y, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(cx, cy, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(cx, cy, contourZ)
                        }
                    }
                    10 -> {
                        with(fillShape) {
                            vertex(x, y, fillZ)
                            vertex(ax, ay, fillZ)
                            vertex(dx, dy, fillZ)

                            vertex(bx, by, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)

                            vertex(bx, by, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)

                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(dx, dy, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(bx, by, contourZ)
                            vertex(cx, cy, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    11 -> {
                        with(fillShape) {
                            vertex(x, y, fillZ)
                            vertex(ax, ay, fillZ)
                            vertex(x, y + spacing, fillZ)

                            vertex(bx, by, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)
                            vertex(x, y + spacing, fillZ)

                            vertex(ax, ay, fillZ)
                            vertex(bx, by, fillZ)
                            vertex(x, y + spacing, fillZ)
                        }

                        with(contourShape) {
                            vertex(ax, ay, contourZ)
                            vertex(bx, by, contourZ)
                        }
                    }
                    12 -> {
                        with(fillShape) {
                            vertex(x, y, fillZ)
                            vertex(x + spacing, y, fillZ)
                            vertex(bx, by, fillZ)

                            vertex(x, y, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(bx, by, fillZ)
                        }

                        with(contourShape) {
                            vertex(bx, by, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    13 -> {
                        with(fillShape) {
                            vertex(x, y, fillZ)
                            vertex(x + spacing, y, fillZ)
                            vertex(bx, by, fillZ)

                            vertex(x, y, fillZ)
                            vertex(x, y + spacing, fillZ)
                            vertex(cx, cy, fillZ)

                            vertex(bx, by, fillZ)
                            vertex(cx, cy, fillZ)
                            vertex(x, y, fillZ)
                        }

                        with(contourShape) {
                            vertex(bx, by, contourZ)
                            vertex(cx, cy, contourZ)
                        }
                    }
                    14 -> {
                        with(fillShape) {
                            vertex(dx, dy, fillZ)
                            vertex(x, y, fillZ)
                            vertex(x + spacing, y, fillZ)

                            vertex(cx, cy, fillZ)
                            vertex(x + spacing, y, fillZ)
                            vertex(x + spacing, y + spacing, fillZ)

                            vertex(cx, cy, fillZ)
                            vertex(dx, dy, fillZ)
                            vertex(x + spacing, y, fillZ)
                        }

                        with(contourShape) {
                            vertex(cx, cy, contourZ)
                            vertex(dx, dy, contourZ)
                        }
                    }
                    15 -> {
                        // Saves some unnecessary draws
                        if (abs(threshold - nw) < 0.025) {
                            with(fillShape) {
                                vertex(x, y, fillZ)
                                vertex(x + spacing, y, fillZ)
                                vertex(x + spacing, y + spacing, fillZ)

                                vertex(x, y, fillZ)
                                vertex(x, y + spacing, fillZ)
                                vertex(x + spacing, y + spacing, fillZ)
                            }
                        }
                    }
                }
            }
        }

        fillShape.endShape(CLOSE)
        shape(fillShape)

        contourShape.endShape(CLOSE)
        shape(contourShape)
    }

    private fun binaryToDecimal(a: Double, b: Double, c: Double, d: Double, threshold: Double): Int {
        val aBit = if (a > threshold) 8 else 0
        val bBit = if (b > threshold) 4 else 0
        val cBit = if (c > threshold) 2 else 0
        val dBit = if (d > threshold) 1 else 0

        return aBit + bBit + cBit + dBit
    }

    override fun keyPressed() {
        when (key) {
            'r' -> {
                seed = System.currentTimeMillis()
                simplex = OpenSimplex2S(seed)
                noiseSeed(seed)
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