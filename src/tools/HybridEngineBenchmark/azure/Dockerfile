# The load generator image that runs in the same Azure region as the sites under test.
#
# Build context layout (the README in the parent folder has the commands):
#   app/     the output of "dotnet publish LoadGen -c Release"
#   paths/   the path lists the suites read (uniform-html.txt, zipf-html.txt, ...)
#
# A shell is required because a suite is a sh script that runs LoadGen many times, so the image is not chiseled.
FROM mcr.microsoft.com/dotnet/runtime:10.0
WORKDIR /app
COPY app/ /app/
COPY paths/ /app/paths/
ENTRYPOINT ["dotnet", "/app/LoadGen.dll"]
