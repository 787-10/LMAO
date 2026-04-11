from setuptools import find_packages, setup

package_name = "lmao_fdir"

setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="LMAO Team",
    maintainer_email="team@787-10.dev",
    description="LMAO — Large Multi-Agent Orchestration on the Innate MARS rover",
    license="MIT",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "hello_node = lmao_fdir.hello_node:main",
        ],
    },
)
